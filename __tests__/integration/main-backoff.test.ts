/**
 * Real SDK regression test for the ordinary (non-child) session backoff.
 *
 * Guards against "every retry waits only the base delay, no exponential
 * backoff". Pi >= 1.2 prepares a hidden retry turn asynchronously, so right
 * after pi.sendMessage() the low-level Agent has no active run and
 * Agent.waitForIdle() resolves at once. The retry loop used to treat that as
 * "the retry finished", exit, and get restarted by agent_end with its attempt
 * counter reset to zero.
 *
 * The test uses a real AgentSession and a faux provider that fails with the
 * same retryable error several times, then checks that the gaps between
 * consecutive failures grow by the configured multiplier.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import retryExtension from "../../retry.ts";

const temporaryRoots: string[] = [];

// Remove temporary directories whether the test passes or fails.
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fixed error text that the extension classifies as retryable. */
const TRANSIENT_ERROR = "deterministic transient connection error";

/** Extra delay before a queued run really starts, mimicking Pi >= 1.2 run preparation. */
const RUN_PREPARE_DELAY_MS = 40;

describe("ordinary session backoff", () => {
  // TEST target: retry.ts[waitForHiddenRunStart, triggerInvisibleContinue]
  it("grows the delay between consecutive failures instead of repeating the base delay", async () => {
    const baseDelayMs = 300;
    const root = mkdtempSync(join(tmpdir(), "pi-retry-main-backoff-"));
    temporaryRoots.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(join(root, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    // Ordinary-session policy: 300ms base, x2, and a cap far above the test range.
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({
        piRetry: { baseDelayMs, maxDelayMs: 60_000, multiplier: 2, maxRetriesAtMaxDelay: 3 },
      }),
      "utf8",
    );

    const faux = fauxProvider({
      provider: "pi-retry-test-main",
      api: "pi-retry-test-api",
      models: [{ id: "pi-retry-test-model", name: "Retry test model", reasoning: false }],
      tokenSize: { min: 1, max: 1 },
    });
    // Real sessions fail after a tool turn inside the same run: one tool call
    // first, then four failures in a row, then success. A thrown error is the
    // same path as a real "Provider is not configured" / 503 stream failure.
    const failure = () => () => {
      throw new Error(TRANSIENT_ERROR);
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("noop_tool", {}, { id: "c1" }), { stopReason: "toolUse" }),
      failure(), failure(), failure(), failure(),
      fauxAssistantMessage("ok"),
    ]);
    const noopTool = defineTool({
      name: "noop_tool",
      label: "Noop",
      description: "Return a fixed result.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const model = modelRuntime.getModel("pi-retry-test-main", "pi-retry-test-model");
    if (!model) throw new Error("The deterministic test model was not registered.");

    const settingsManager = SettingsManager.inMemory({
      // Same as a typical user setup: native retry on, suppressed by the extension.
      retry: { enabled: true, maxRetries: 5, baseDelayMs: 300 },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        retryExtension,
        // Another extension with a slow async before_agent_start handler, as in
        // a real setup with many extensions; it delays the real run start.
        (pi: any) => {
          pi.on("before_agent_start", async () => {
            await new Promise<void>(resolve => setTimeout(resolve, RUN_PREPARE_DELAY_MS));
          });
        },
      ],
    });
    // The extension reads settings by cwd while its factory runs, so switch the
    // process directory only for the reload.
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loader.reload();
    } finally {
      process.chdir(previousCwd);
    }

    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager,
      customTools: [noopTool],
    });
    await session.bindExtensions({ mode: "print" });

    // Make the delayed run start independent of the installed SDK version:
    // Pi 1.1 starts the Agent run synchronously, Pi >= 1.2 does not. Delaying
    // hidden custom messages reproduces the Pi >= 1.2 timing on both.
    const internals = session as any;
    const originalSendCustomMessage = internals.sendCustomMessage.bind(session);
    internals.sendCustomMessage = async (message: any, options: any) => {
      if (message?.customType === "pi-retry:retry") {
        await new Promise<void>(resolve => setTimeout(resolve, RUN_PREPARE_DELAY_MS));
      }
      return originalSendCustomMessage(message, options);
    };

    // Record when each failed assistant message lands; neighbouring
    // differences are the real backoff durations.
    const errorTimes: number[] = [];
    let recovered: (() => void) | undefined;
    const done = new Promise<void>(resolve => {
      recovered = resolve;
    });
    session.subscribe((event: any) => {
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      if (event.message.stopReason === "error") errorTimes.push(Date.now());
      // Only a final normal stop counts as recovery; a tool-call turn does not.
      else if (event.message.stopReason === "stop") recovered?.();
    });

    try {
      await session.prompt("hi");
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for recovery")), 20_000)),
      ]);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }

    const gaps = errorTimes.slice(1).map((time, index) => time - errorTimes[index]);
    expect(errorTimes.length).toBe(4);
    // Expected roughly 300 / 600 / 1200ms plus the run preparation delay. A
    // flat schedule would give about 300ms three times.
    expect(gaps[0]).toBeGreaterThanOrEqual(baseDelayMs);
    expect(gaps[1]).toBeGreaterThanOrEqual(baseDelayMs * 2);
    expect(gaps[2]).toBeGreaterThanOrEqual(baseDelayMs * 4);
  }, 30_000);
});
