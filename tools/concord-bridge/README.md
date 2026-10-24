# concord-bridge

A local stdio MCP server that dispatches a fleet agent as a headless worker
(`claude`, `codex` or `agy`) in its own git worktree, relays the worker's
questions back to the dispatching session, and records every run in a
hash-chained audit ledger.

## Build

`dist/` is gitignored and nothing builds it at launch, so build it once per
checkout, and again after pulling changes to `src/`:

```bash
npm --prefix tools/concord-bridge ci
npm --prefix tools/concord-bridge run build
```

`.mcp.json` and `.codex/config.toml` both launch
`node tools/concord-bridge/dist/index.js` from the repository root, with
no network fetch at launch. If `dist/index.js` is missing, the server fails to
start and the host shows the MCP server as failed.

Test and coverage (Istanbul, lcov at `coverage/lcov.info`):

```bash
npm --prefix tools/concord-bridge test
npm --prefix tools/concord-bridge run test:coverage
```

The tests create throwaway git repositories under the OS temp directory. They
never touch the checkout they run from.

## What it spawns

One process per dispatch and one per reply, always with `shell: false`:

| Harness | Command | Access mapping | Turn cap |
|---|---|---|---|
| claude | `claude -p --model … --effort … --permission-mode plan\|acceptEdits --max-turns N --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence -- <prompt>` | `read-only` becomes `plan`; both write tiers become `acceptEdits` | `--max-turns` |
| codex | `codex exec -m … -c model_reasoning_effort=… --sandbox read-only\|workspace-write -C <worktree> -- <prompt>` | `read-only` becomes `read-only`; both write tiers become `workspace-write` | not enforced (no flag) |
| antigravity | `agy run --model … --effort … -- <prompt>` | not enforced | not enforced |

Only the claude flags were checked against a live CLI (Claude Code 2.1.307).
The codex flags come from the upstream CLI source. The `agy` argv is unverified.

Each worker gets a 30-minute SIGKILL timeout and a 2 MiB cap on combined
stdout and stderr. A worker reports a pause by printing
`[AWAITING_INPUT:<nonce>]` or `[PERMISSION_REQUIRED:<nonce>]`. The nonce is
random for each run and is given only in that run's prompt. The exit code is
checked first: a signal, a timeout, the output cap or a non-zero exit is
`FAILED`, whatever markers the output holds.

Workers cannot dispatch further workers. Claude workers load no MCP servers.
Every worker also runs with `CONCORD_BRIDGE_WORKER=1`. A bridge started inside
a bridge-created worktree refuses to dispatch, and so does one whose
environment carries that flag.

## Where it writes

| Path (repo root) | What |
|---|---|
| `.worktrees/<session-id>/` | one worktree per dispatch. Created with `git worktree add`, never reused; an existing target is refused |
| `.agent-bus/audit/ledger.jsonl` | append-only, mode 0600, one record per dispatch or reply. Each record holds `prev_hash` and `hash` (SHA-256), so `bridge_query_audit_log {"verify_chain": true}` detects edited, deleted or reordered lines. Common token and key shapes are redacted before writing |
| `.agent-bus/workers/<session-id>.json` | marker file for the recursion guard |

Both directories are gitignored at the repository root. The bridge never deletes
a directory except through `git worktree remove`.

## red-team-critical activation

A `red-team-critical` dispatch is admitted only when one of these holds:

- **RC-1 / RC-2.** A `context_files` entry that exists in the repository, or a
  path changed on the requested existing `branch`, falls under the core-crypto
  (RC-1) or key-custody (RC-2) prefixes in `src/gate/activation.ts`. Prompt
  text is never inspected.
- **RC-3.** `escalation_task_id` names a completed audit-ledger entry, written
  by this bridge, of a `red-team` run whose output reports a CRITICAL or
  HIGH finding (`P0`/`P1`).
- **RC-4.** None of the above holds, and a human approves through **MCP
  elicitation** (`elicitation/create`, a yes/no form). If the MCP client does
  not declare the elicitation capability, the request errors or times out (5
  minutes), or the human declines, the dispatch is refused.

The audit record stores the criterion that admitted the dispatch.

RC-1 and RC-2 rest on paths the caller supplies. They route intent, and they
are not an authorization boundary. RC-4 is the only criterion that a model
cannot satisfy by itself.
