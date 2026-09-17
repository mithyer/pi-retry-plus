# @mithyer/pi-retry-plus

A fork of [@monotykamary/pi-retry](https://github.com/monotykamary/pi-retry).

This fork keeps the original retry behavior and adds special configuration for Pi subagents. It is intended for personal use and will generally stay synchronized with the upstream project, while additional features may be added when needed.

## Subagent configuration

Enable the child-session retry policy in Pi settings:

```json
{
  "piRetry": {
    "subagents": {
      "enabled": true,
      "match": {
        "systemPromptRegex": [
          {
            "pattern": "^<active_agent name=\"[^\"\\r\\n]+\"/>$",
            "flags": "m"
          }
        ]
      }
    }
  }
}
```

`pi-subagents` prefixes native child system prompts with an `<active_agent .../>` line. The multiline regular expression above selects those sessions for the child-specific retry policy.

The extension must also be loaded by the child agent. For an agent definition, add:

```yaml
subagentOnlyExtensions:
  - /absolute/path/to/retry.ts
```

## Upstream

- Forked from: <https://github.com/monotykamary/pi-retry>
- Upstream behavior is kept as the compatibility baseline.
- This fork may contain extra behavior that is not present upstream.
