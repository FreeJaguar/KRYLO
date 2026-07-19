# Status Lines

## Subagent status line

KRYLO may provide `subagentStatusLine` through plugin settings because this key is supported for plugin settings.

Each visible row should show:

- Agent name.
- Resolved model when available.
- State.
- Elapsed time.
- Short task description.

Example:

```text
* krylo:builder | Sonnet | working 00:48 | implementing export flow
* krylo:reviewer | Opus | still working 02:17 | reviewing final diff
* krylo:verifier | Sonnet | waiting for result 01:04 | production build
```

## State heuristics

- `starting`: running under 20 seconds.
- `working`: recent activity and under 90 seconds.
- `still working`: recent activity over 90 seconds.
- `long task`: recent activity over five minutes.
- `waiting for result`: known background or tool wait.
- `no new activity`: no recent token or event movement.
- `suspected stuck`: prolonged inactivity with no known wait.
- `completed`, `failed`, `stopped`, or `cancelled` from runtime state.

A running state alone is not proof of progress.

## Main status line

A plugin cannot ship an arbitrary main `statusLine` through its plugin settings. `/krylo:setup` may offer a user-level wrapper after a dry run and backup.

The wrapper must preserve an existing status line when possible and support full removal.

## Privacy

Status lines must never display prompts, commands, tool arguments, source code, secrets, database values, or external response bodies.
