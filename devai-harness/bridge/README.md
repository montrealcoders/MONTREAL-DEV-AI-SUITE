# devai-bridge — bridge protocol v0

The DEV-AI Suite side door into the embedded DSH runtime. `devai-bridge` is
an ordinary dsh plugin (no core fork): it is mounted through the same layered
patch composition as every other plugin — the bridge-mode boot entry
(`../src/bridge-main.ts`) inserts it via the overlay slot — and it talks to
the composed runtime exclusively through the documented seams (`ctx.agents`,
`ctx.sessionPersistence`, `session/event`, `agent/status`, the
`approval/request` waterfall).

**Versioning.** This document describes **bridge protocol v0**, contracted
against the pinned runtime **DeepSeek Harness v0.1.1-rc.2**. The dsh session
event vocabulary is pre-1.0 and the upstream announces breaking changes, so
the protocol version and the runtime pin move together: any pin bump requires
a green contract run (`npm run test:bridge`), and any wire change bumps
`BRIDGE_PROTOCOL_VERSION`.

## Transport

JSON-RPC 2.0 over newline-delimited JSON (one frame per line) on the child
process's stdio. Stdout carries only protocol frames; diagnostics go to
stderr. The framing implementation is the pinned runtime's own
`@deepseek-ai/dsh-sdk-protocol` line transport, so the bridge adds no
third-party dependency.

Both directions carry requests: the client drives sessions, and the server
issues `approval/request` back to the client while a tool call waits on the
harness's fail-closed approval seam.

## Client -> server requests

| Method | Params | Result |
|---|---|---|
| `initialize` | — | `{ protocol: { name: 'devai-bridge', version: 0 }, runtime: { name: 'dsh', pin: '0.1.1-rc.2' }, providers: [{ id, name }] }`. Waits for the composed plugin tree to settle before answering, so the first session sees every sibling capability. |
| `session/create` | `{ sessionId?, cwd?, provider?, model? }` | `{ sessionId }`. Creates the session and its driving agent. Unspecified provider/model fall back to the composition's default model selection. |
| `session/list` | — | `{ sessions: [{ sessionId, createdAt, cwd?, parentSession?, live }] }` from the composed persistence backend; `live` marks sessions currently in the agent registry. |
| `session/resume` | `{ sessionId }` | `{ sessionId, events }`. Loads the persisted log, resumes a live agent on it, and returns the full replayed event log so the client can render history. Resuming a session this bridge already drives returns the current log. |
| `session/prompt` | `{ sessionId, content }` | `{ messageId }`. `content` is a string (one text block) or an array of dsh content blocks. Queues one identified user turn; later activity streams via `session/event` and is not assigned to this request. |
| `session/interrupt` | `{ sessionId }` | `{}`. Cancels the active turn (cause `user`); the session stays live. |
| `session/close` | `{ sessionId }` | `{}`. Disposes the live agent without deleting durable data; the session can be resumed later. Unknown ids are a no-op. |
| `shutdown` | — | `{}`. Disposes bridge-owned agents, then (after the response is flushed) disposes the complete root runtime — persistence included — and exits 0. |

Errors are standard JSON-RPC error responses (`-32603` with the failure
message; `-32601` for unknown methods).

## Server -> client notifications

| Method | Params |
|---|---|
| `session/event` | `{ sessionId, event }` — every durable dsh `SessionEvent` exactly as appended (`{ type, seq, time, data, … }`): `turn/*`, `step/*`, `user/message`, `assistant/chunk` (token-level streaming), `assistant/message`, `tool/call`, `tool/result`, `session/title`, `approval/*` audit records, and any plugin-extended types. Events stream for **all** sessions in the runtime (subagent children included), keyed by their own ids; the client filters. |
| `session/status` | `{ sessionId, status }` — agent lifecycle transitions (`idle` / `running`). |

## Server -> client requests

| Method | Params | Expected result |
|---|---|---|
| `approval/request` | `{ requestId, sessionId, toolName, callId?, reason? }` | `{ outcome }` where `outcome` is one of `allowed-once`, `rejected`, `cancelled`, `unavailable`. |

The bridge answers the harness approval waterfall only for sessions it owns
and preserves the seam's fail-closed stance: a transport failure or an
unrecognized answer resolves `unavailable`, and a request withdrawn by the
runtime resolves `cancelled`. The paired `approval/asked` / `approval/decided`
audit events stream on `session/event` like every other durable fact.

## Layout

| Path | Role |
|---|---|
| `src/index.js` | The plugin (`name`, `inject`, `apply`) and the `DevaiBridgeServer` protocol methods. Plain JavaScript because the Loader imports it through `node_modules`, where Node performs no type stripping. |
| `../src/bridge-main.ts` | Bridge-mode boot entry: boots the `devai` profile with this plugin inserted through the overlay patch slot, then serves until `shutdown`, stdin EOF, or a signal. |
| `../test/bridge-protocol.test.ts` | Contract test: spawns the real boot, drives a session over stdio against a loopback OpenAI-compatible mock endpoint, and asserts the streamed event order, the approval round-trip, list/close/resume, and a clean exit. |

## Running the contract test

```sh
cd devai-harness
npm install
npm run test:bridge     # or npm test for Phase 1 + Phase 2 together
```

Requires Node `^22.19.0 || >=24`; network only for the component's own
`npm install`. The test creates a throwaway harness home under
`devai-harness/.tmp-bridge-test-home/` (gitignored) and fakes the model with
a local HTTP server, so no real model route is exercised.
