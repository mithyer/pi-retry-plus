import { describe, expect, it, vi } from "vitest";
import { ChildRetryController } from "../../src/child-retry.js";

interface Fixture {
  agent: { state: { messages: any[] } };
  controller: any;
  delays: number[];
  sends: unknown[];
  statusUpdates: Array<{ key: string; text: string | undefined }>;
  notifications: Array<{ message: string; level: string }>;
  ctx: any;
}

/**
 * Create a controller fixture with wall-clock waiting replaced by a recorder.
 *
 * @param config Retry policy used by the controller.
 * @returns Controller, fake SDK objects, and observed scheduling data.
 */
function createFixture(
  config: {
    baseDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    maxRetriesAtMaxDelay: number;
  },
  options: { stubBackoff?: boolean } = {},
): Fixture {
  const delays: number[] = [];
  const sends: unknown[] = [];
  const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const errorMessage = "connection error";
  const assistantError = {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [],
  };
  const agent = {
    state: { messages: [assistantError] },
  };
  const ctx = {
    signal: new AbortController().signal,
    sessionManager: {
      getEntries: () => [{ type: "message", message: assistantError }],
    },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => statusUpdates.push({ key, text }),
    },
  };
  const pi = {
    events: { emit: () => undefined },
    sendMessage: (message: unknown) => sends.push(message),
  };
  const controller = new ChildRetryController(pi as any, agent as any, {
    enabled: true,
    ...config,
    match: { systemPromptRegex: [] },
  }) as any;

  // Keep most tests fast while preserving the production delay calculation and send path.
  if (options.stubBackoff !== false) {
    controller.waitForBackoff = async (delay: number) => {
      delays.push(delay);
      return true;
    };
  }
  return { agent, controller, delays, sends, statusUpdates, notifications, ctx };
}

describe("ChildRetryController retry lifecycle", () => {
  // TEST:__tests__/unit/child-retry.test.ts[tool success resets retry backoff]
  it("starts at the base delay after a successful tool turn", async () => {
    const fixture = createFixture({
      baseDelayMs: 10,
      maxDelayMs: 1_000,
      multiplier: 2,
      maxRetriesAtMaxDelay: 2,
    });

    await fixture.controller.handleAgentEnd(fixture.ctx);
    fixture.controller.handleTurnEnd(
      { message: { role: "assistant", stopReason: "toolUse" } },
      fixture.ctx,
    );
    await fixture.controller.handleAgentEnd(fixture.ctx);

    expect(fixture.delays).toEqual([10, 10]);
  });

  // TEST:__tests__/unit/child-retry.test.ts[retry countdown updates one status row]
  it("updates one status row during the backoff countdown", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture(
        {
          baseDelayMs: 250,
          maxDelayMs: 1_000,
          multiplier: 2,
          maxRetriesAtMaxDelay: 2,
        },
        { stubBackoff: false },
      );
      const schedule = fixture.controller.handleAgentEnd(fixture.ctx);

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(50);
      await schedule;

      const countdownUpdates = fixture.statusUpdates.filter(update => update.text !== undefined);
      expect(countdownUpdates.map(update => update.key)).toEqual([
        "pi-retry-backoff",
        "pi-retry-backoff",
        "pi-retry-backoff",
      ]);
      expect(countdownUpdates.map(update => update.text)).toEqual([
        "Retry attempt 1 - retrying in 250ms",
        "Retry attempt 1 - retrying in 150ms",
        "Retry attempt 1 - retrying in 50ms",
      ]);
      expect(fixture.statusUpdates.at(-1)).toEqual({
        key: "pi-retry-backoff",
        text: undefined,
      });
      expect(fixture.notifications).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // TEST:__tests__/unit/child-retry.test.ts[fresh input resets retry backoff]
  it("starts at the base delay after fresh user input", async () => {
    const fixture = createFixture({
      baseDelayMs: 10,
      maxDelayMs: 1_000,
      multiplier: 2,
      maxRetriesAtMaxDelay: 2,
    });

    await fixture.controller.handleAgentEnd(fixture.ctx);
    await fixture.controller.handleAgentEnd(fixture.ctx);
    fixture.controller.handleInput();
    await fixture.controller.handleAgentEnd(fixture.ctx);

    expect(fixture.delays).toEqual([10, 20, 10]);
  });

  // TEST:__tests__/unit/child-retry.test.ts[manual retry after cap]
  it("allows a manual retry to start a fresh lifecycle after the cap", async () => {
    const fixture = createFixture({
      baseDelayMs: 10,
      maxDelayMs: 10,
      multiplier: 2,
      maxRetriesAtMaxDelay: 2,
    });

    for (let index = 0; index < 3; index++) {
      await fixture.controller.handleAgentEnd(fixture.ctx);
    }
    const sendsBeforeManual = fixture.sends.length;
    const delaysBeforeManual = fixture.delays.length;

    await fixture.controller.retryManually(fixture.ctx);

    expect(fixture.sends).toHaveLength(sendsBeforeManual + 1);
    expect(fixture.delays).toHaveLength(delaysBeforeManual + 1);
    expect(fixture.delays.at(-1)).toBe(10);
  });

  // TEST:__tests__/unit/child-retry.test.ts[manual retry cancels active backoff]
  it("cancels an active backoff before starting a manual retry", async () => {
    const fixture = createFixture({
      baseDelayMs: 10,
      maxDelayMs: 1_000,
      multiplier: 2,
      maxRetriesAtMaxDelay: 2,
    });
    const automatic = fixture.controller.handleAgentEnd(fixture.ctx);
    const manual = fixture.controller.retryManually(fixture.ctx);

    await Promise.all([automatic, manual]);

    expect(fixture.sends).toHaveLength(1);
    expect(fixture.delays).toEqual([10, 10]);
  });
});
