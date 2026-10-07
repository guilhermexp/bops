# lib/server/runtime — model runtimes

## Purpose

How Bops reaches its models, by capability. A runtime is a way to run a capability: `openai` (OpenAI's API with `OPENAI_API_KEY`, or Bops Cloud when signed in with Orgo; the upstream behavior) or `codex` (the user's ChatGPT plan, through the account they signed in to Codex with). Callers know only a capability's interface, never an SDK or a wire protocol.

| Path | What's there |
|---|---|
| `config.ts` | Runtime ids (`RUNTIMES`), `runtimeFor(capability)`: `BOPS_<CAP>_RUNTIME` over `BOPS_RUNTIME`, default `openai`, unknown id = error naming the variable |
| `codex/auth.ts` | `codexHome()`, `readCodexAuth()` (auth.json + JWT claims: account id, plan, expiry), `codexAuth(stale?)` (renewal through Codex's app server), `CodexSignInError` |
| `codex/client.ts` | `codexResponses(body, session)`: POST `{BOPS_CODEX_BASE_URL}/responses`, SSE, 401 → renew once, `CodexLimitError` with reset time, standing limit until reset |
| `text/types.ts` | The text contract: `TextRequest`, `TextReply` (`text`, `calls`, `next(outputs)`), `TextRuntime`, `modelFor(role)` |
| `text/index.ts` | Registry by runtime id; `generateText(req)`, the only entry callers use for answers; `textOutOfCredit()`, the chat's credit gate |
| `text/openai.ts`, `text/codex.ts` | Text in each runtime |
| `tasks/types.ts`, `tasks/index.ts` | Task contract (`open`, `turn`, `close`, host/credit checks), runtime registry, native Mac entry |
| `tasks/openai.ts`, `tasks/codex.ts` | Agents API/executor or ChatGPT app-server, events and token usage |

## Ownership

- Core of the runtime queue (fila-runtime-codex): `config.ts`, `codex/`, `text/`. Nodes `tasks` and `voice` add `tasks/` and `voice/` with the same shape.
- Text callers: `chat.ts` (acknowledge, askTeammate, botTurn's tool loop), `memory.ts` (auto-remember), `watches.ts` (suggestWatch, watchInstead), `sessions.ts` (`suggestReplies` only), `phone-voice.ts` (each phone turn).
- Task caller: `sessions.ts` owns routing, screens, instructions/memory, chat results and notifications. It calls only `tasks/index.ts`; the runtime owns the model/tool protocol and executor. Native "Your Mac" always uses `macTasksRuntime()` (Codex), in both runtimes.
- Not yet behind a runtime: voice (`call.ts`, SIP in `phone.ts`), which still uses `openaiClient()` whatever `BOPS_VOICE_RUNTIME` says.

## Local Contracts

- **Selection is per call** (`runtimeFor` reads env each time). No silent fallback: an unknown id rejects; a capability a runtime can't do must fail with a message naming the runtime to use, never quietly use another runtime or the API.
- **Text contract.** `generateText(req)` → `TextReply`. `req.role` picks the model (`modelFor`: `chat` = `BOPS_CHAT_MODEL` || `BOPS_SAM_MODEL`; `phone` = `BOPS_PHONE_MODEL` || chat's; default `gpt-6.1-sol`), the same names in every runtime. `json` = strict JSON schema output (the reply's `text` is the JSON). `quick` = a turn someone waits on (no retries, `max_output_tokens`, `store:false` where the runtime can). `reply.next(outputs)` is one tool-loop round with the same instructions and tools. Each runtime records the call's tokens (`recordTokens(req.usage.source, …)`). `TextRuntime.outOfCredit()` is the credit its provider bills that stops a chat turn before it starts: openai = Bops Cloud's AI credit (`creditsOut`, true only through the cloud); codex = never (the plan's limit comes back as an error). `chat.ts` asks `textOutOfCredit()`, never `creditsOut()` directly.
- **openai** keeps the upstream requests byte for byte (bodies asserted in `scripts/test-phone-voice.mjs`): continuation by `previous_response_id`, cloud proxy and key handling in `../openai-client.ts`.
- **codex** never sends `previous_response_id`, `max_output_tokens` or sampling; always `store:false`, `stream:true`, `include:["reasoning.encrypted_content"]`. A tool loop resends the whole input + every output item (without `id`) + the `function_call_output`s. Headers identify Bops (`originator: bops`, `User-Agent: bops (…)`), never "Codex Desktop".
- **Codex sign-in.** Bops only reads `${CODEX_HOME:-~/.codex}/auth.json`; it never writes it and never uses the refresh token (single use: it would sign the Codex CLI/app out). Renewal = `codex.request("account/read", { refreshToken: true })` on the app server `../codex.ts` runs, then read the file again. No ChatGPT sign-in → `CodexSignInError`, whose message points at Settings → This Mac (the setup card's Sign in, `signInToCodex`).
- **Limits.** 429 / `usage_limit_reached` / `rate_limit_exceeded` (HTTP or `response.failed`) → `CodexLimitError` (reset from `resets_at`, `resets_in_seconds`, or the `x-codex-{primary,secondary}-reset-at` of a window at 100%); that account's calls fail at once until the reset (60 s when unknown). The standing limit carries the `accountId` that reached it: another ChatGPT account signed in to Codex isn't held by it. `cloud.ts` `noteOutOfCredit` takes it (without `state.credits`: no Upgrade card) and `creditNote(e)` is what the bot says: the plan's limit and when it's back.
- **What Codex threads run without** (`../codex.ts` `ready`/`turnedOff`): the app server starts bare, asks `config/read` (Codex's own parser and layers: any TOML spelling), and when `plugins.composio@composio`, `mcp_servers.cua-driver` or `mcp_servers.cua` exist, starts again with them `enabled=false` before anything runs. `-c` keys split on dots and keep quotes, so the plugin key is unquoted (`plugins.composio@composio.enabled=false`); never pass an override for something absent (Codex 0.161.0 exits: "invalid transport").
- **Tasks.** New bot-browser threads use `BOPS_TASK_RUNTIME` over `BOPS_RUNTIME`. A persisted `Session.taskRuntime` pins replies/restarts to the provider that created the thread; old Agents sessions remain OpenAI. `open(req)` returns a resumable id/environment; `opened` persists the id before starting the executor, so a failed connection can retry it. `turn(req)` emits steps, captions and a final answer through protocol-free hooks; `close` releases its executor/listener. `sessions.ts` owns Orgo screen claims; `openai.ts` preserves Agents bodies, helper attribution, polling/settling and token accounting. Bops Cloud credit gates only OpenAI tasks; native Mac tasks always use the plan.
- **Codex browser tasks.** Only host `mac`; reject `orgo` in the queue before provisioning or touching a computer, naming `BOPS_TASK_RUNTIME=openai`. Threads run in `~/.bops/workspace` with workspace-write sandbox and `approvalPolicy: never`; per-thread `sandbox_workspace_write` resets writable_roots to [] (only cwd), network_access to false and both tmp exclusions to true, on start and resume, regardless of the user config; the dedicated required Playwright MCP connects to that bot's CDP port and has `default_tools_approval_mode: approve` only for its explicit `enabled_tools` allowlist of browser interactions/page evaluation. Never expose `browser_run_code_unsafe`, installers or host file uploads: the MCP runs outside the command sandbox. Artifacts go to the workspace (`--output-dir`), with Playwright's default file-access checks. Live web search stays on. Per-thread config disables personal MCPs/plugins and skills (using exact paths returned by `skills/list`), and sets `project_doc_max_bytes: 0`: personal coding instructions must not redirect a bot to the user's browser. No user config/auth file is written. Native threads keep read-only sandbox, user approvals, computer-use plugin skill, and Bops app tools.
- **Codex events/lifecycle.** Native messages without `phase` also become live note steps/captions, with only the final answer note removed at completion. Structured `codexErrorInfo: rateLimitExceeded` uses the core plan-limit path. Reasoning summary deltas become live captions; narration/actions supply captions when no summary was emitted. MCP calls, web searches and commands become steps; final agent messages become the answer. Stop binds before `turn/start`, interrupts once the id arrives (also after a late response), and ends after a terminal event or a 10 s stop watchdog; a turn timeout also interrupts. `thread/unsubscribe` releases the loaded thread/tool processes; `thread/resume` loads its saved history and current per-thread tools on a reply/restart. Failed resumes surface errors rather than silently replacing history. Usage records each positive delta of `tokenUsage.total`, not `last` (one tool loop has several model requests); `taskTokens` persists the baseline. A legacy thread without a baseline starts from its first reported last request. Limits/sign-in use the core error classes and `creditNote`, without an Upgrade card for a plan limit.
- **Task models.** Low/medium use `BOPS_SESSION_MODEL` (default `gpt-6.1-sol`); high uses `BOPS_HARD_MODEL` (default `gpt-6-astra`). Blank overrides use the default; reasoning effort/summary are set per turn.
- **Adding a runtime:** add its id to `RUNTIMES` in `config.ts`; add `<capability>/<id>.ts` implementing that capability's interface for each capability it supports, and its entry in `<capability>/index.ts`'s registry. For a capability it doesn't support, its entry throws an error naming the runtime to use. Callers don't change. Add its fakes to `scripts/test-runtime-text.mjs` (and the capability's test) and its variables to `.env.example` and README "Model runtimes".
- **Adding a capability** (`tasks/`, `voice/`): `types.ts` (the interface, protocol-free), `index.ts` (registry by `RuntimeId` + one entry function that calls `runtimeFor("<cap>")`), one file per runtime.

## Work Guidance

- Import the capability as `./runtime/text/index` (explicit `index`): the script tests' module hooks don't resolve directory imports.
- `codex/auth.ts` reaches `../codex.ts` by dynamic import on purpose: `codex.ts` imports `codexHome` from it and checks the Mac as it loads.
- Never log or return tokens; error messages carry ChatGPT's message and status only.
- Next.js 16: nothing here uses Next APIs; server-only modules (`import "server-only"`).

## Verification

```bash
node --conditions=react-server scripts/test-runtime-text.mjs                    # everything: selection, codex body, tool loop, JSON, renewal (also 3 at once), sign-in, limit (per account), stream failures, openai unchanged, cloud credit gate, Codex starting
node --conditions=react-server scripts/test-runtime-text.mjs codex-config       # only Codex starting on a config without them (needs the Codex CLI; skipped without)
node --conditions=react-server scripts/test-runtime-text.mjs codex-config-toml  # only: quoted / dotted-under-parent / inline-table spellings all turned off
node --conditions=react-server scripts/test-runtime-text.mjs text               # only the fake-backend sections (no Codex CLI)
node --conditions=react-server scripts/test-runtime-tasks.mjs               # session/chat result without API key; events, captions, tool-loop tokens, persisted replies, stop races, resume, host refusal before provisioning, OpenAI bodies/events, native Mac policy, explicit safe browser tools, inherited sandbox reset, structured rate limits and missing-phase narration
node --conditions=react-server scripts/test-phone-voice.mjs                # phone turns on openai (bodies) and on codex
```

Fakes only: Codex backend and OpenAI on localhost, `CODEX_HOME` in a temp dir with a made-up JWT, Codex's renewal stubbed on the `codex` object; the Codex app server it starts gets a dead proxy. Tasks use the same temporary state/workspace with the `codex` singleton stubbed and Agents API on localhost; Chrome, memory, routing decisions and notifications are stubbed. Against the real backend: the root AGENTS.md "Roteiro de verificação real" with `BOPS_RUNTIME=codex` and no `OPENAI_API_KEY`.

## Child DOX Index

Nenhum filho ainda.
