// Tasks capability (lib/server/runtime/tasks): threads on the user's ChatGPT plan through Codex's
// app-server (Mac Chrome via Playwright MCP, live web search, workspace commands, reasoning captions,
// steps, a later reply on the same thread, stop, resume, tokens), a cloud computer refused with the
// runtime to use, and the OpenAI Agents API path unchanged. The app-server is the codex singleton
// stubbed for task turns; safety checks also use the real CLI parser/tool filter without model
// turns. The Agents API is a fake on localhost; Codex's home and the Mac workspace are a
// temporary folder. Nothing reaches the network.
// Usage: node --conditions=react-server scripts/test-runtime-tasks.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of ["BOPS_DATABASE_URL", "ORGO_API_KEY", "OPENAI_API_KEY", "OPENAI_EXECUTOR_API_KEY", "BOPS_RUNTIME", "BOPS_TEXT_RUNTIME", "BOPS_TASK_RUNTIME", "BOPS_VOICE_RUNTIME", "BOPS_SESSION_MODEL", "BOPS_HARD_MODEL", "BOPS_CHAT_MODEL", "BOPS_CODEX_BASE_URL"])
  delete process.env[k];
const realCodexBin = spawnSync("which", ["codex"], { encoding: "utf8" }).stdout?.trim();
const scratch = mkdtempSync(join(tmpdir(), "bops-test-runtime-tasks-"));
const codexHome = join(scratch, "codex-home");
const bin = join(scratch, "bin");
mkdirSync(codexHome, { recursive: true });
mkdirSync(bin, { recursive: true });
// Stays quiet: the OpenAI executor treats a few seconds without "error" as connected.
writeFileSync(join(bin, "codex"), "#!/bin/sh\nsleep 30\n");
chmodSync(join(bin, "codex"), 0o755);
const authPath = join(codexHome, "auth.json");
const jwt = (payload) => {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.x`;
};
const signIn = () =>
  writeFileSync(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_test", chatgpt_plan_type: "pro" } }),
        account_id: "acct_test",
      },
    }),
  );
signIn();
Object.assign(process.env, {
  BOPS_SELF_HOSTED: "1",
  BOPS_COMPUTER_TOOL: "0",
  BOPS_CDP_BASE_PORT: "19730",
  CODEX_HOME: codexHome,
  PATH: `${bin}:${process.env.PATH}`,
  OPENAI_API_KEY: "sk-test-not-a-real-key",
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
});
process.chdir(scratch);
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;

const calls = [];
let heldTurn;
let holdNextTurn = false;
const listeners = new Map();
globalThis.__bopsTestCodex = {
  ready: async () => {},
  request: async (method, params) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) });
    if (method === "config/read") return { config: { sandbox_workspace_write: { writable_roots: [scratch], network_access: true, exclude_slash_tmp: false, exclude_tmpdir_env_var: false }, mcp_servers: { personal_browser: { command: "false" } }, plugins: { "other@test": { enabled: true } } } };
    if (method === "skills/list") return { data: [{ skills: [{ path: "/tmp/private-skill/SKILL.md", pluginId: null }, { path: "/tmp/computer-use/SKILL.md", pluginId: "unified-computer-use@openai-bundled" }] }] };
    if (method === "thread/start") return { thread: { id: "thr_1" } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start" && holdNextTurn) { holdNextTurn = false; return await new Promise((resolve) => heldTurn = resolve); }
    if (method === "turn/start") return { turn: { id: `turn_${calls.filter((c) => c.method === "turn/start").length}` } };
    return {};
  },
  on: (id, fn) => listeners.set(id, fn),
  off: (id) => listeners.delete(id),
  waiting: new Map(),
  sessionApps: new Map(),
  listenerMap: listeners,
};
const emit = (threadId, method, params = {}) => listeners.get(threadId)?.({ method, params: { threadId, ...params } });

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// A third runtime exists only in this process. Its continuation is deliberately unlike either provider's.
const fixtureOpens = [];
let fixtureHandleId = 0;
const fixtureControl = { openGate: null, openEntered: null, turnGate: null, turnEntered: null, turns: 0, closed: [] };
globalThis.__bopsFixtureTasks = {
  releaseScreens: true,
  assertHost() {},
  outOfCredit: async () => false,
  resume: (session) => session.taskState,
  snapshot: (thread) => thread.saved,
  open: async (req) => {
    fixtureOpens.push(req.resume);
    if (fixtureControl.openGate) {
      fixtureControl.openEntered?.();
      await fixtureControl.openGate;
    }
    const thread = { id: `fixture_handle_${++fixtureHandleId}`, saved: req.resume ?? { cursor: { page: "first", revision: 0 } } };
    req.opened?.(thread);
    return thread;
  },
  turn: async ({ thread, hooks }) => {
    fixtureControl.turns++;
    const delayed = !!fixtureControl.turnGate;
    if (fixtureControl.turnGate) {
      fixtureControl.turnEntered?.();
      await fixtureControl.turnGate;
    }
    thread.saved = { cursor: { page: "next", revision: thread.saved.cursor.revision + 1 } };
    if (delayed) {
      hooks.step("stale-test", "late step");
      hooks.caption("late caption");
      hooks.saveState?.(thread.saved);
    } else hooks.saveState?.(thread.saved);
    return `Fixture revision ${thread.saved.cursor.revision}`;
  },
  close: async (thread) => { fixtureControl.closed.push(thread.id); },
};
globalThis.__bopsFixtureControl = fixtureControl;
const executorCalls = [];
const executorKills = [];
globalThis.__bopsExecutorCalls = executorCalls;
globalThis.__bopsExecutorKills = executorKills;
globalThis.__bopsTaskChildRunning = false;
globalThis.__enableNativeApps = false;
const orgoCommands = [];
globalThis.__bopsOrgoCommands = orgoCommands;
const STAND_INS = new Set(["codex", "orgo", "relay", "desktop", "mirror", "memory", "decide", "briefing", "screen-watch", "attention", "mail", "phone", "channels", "skills", "plan", "tailnet", "vault", "composio"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    if (url.endsWith("/lib/server/codex.ts?approval-contract")) {
      // Exercise the real approval router, without its startup or periodic process checks.
      const source = readFileSync(new URL(url), "utf8").replace(/g\.__bopsMacCheck \?\?=[\s\S]*$/, "");
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    if (url.endsWith("/runtime/config.ts")) {
      const source = readFileSync(new URL(url), "utf8").replace('["openai", "codex"] as const', '["openai", "codex", "fixture"] as const');
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    if (url.endsWith("/runtime/tasks/index.ts")) {
      const source = readFileSync(new URL(url), "utf8").replace('codex: codexTasks }', 'codex: codexTasks, fixture: globalThis.__bopsFixtureTasks }');
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    if (url.endsWith("/lib/server/user-paths.ts")) {
      const source = readFileSync(new URL(url), "utf8").replace('join(homedir(), ".bops")', `join(${JSON.stringify(scratch)}, ".bops")`);
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    if (url.endsWith("/lib/server/local.ts")) {
      const source = readFileSync(new URL(url), "utf8").replace('join(homedir(), ".bops")', `join(${JSON.stringify(scratch)}, ".bops")`).replace("export async function ensureChrome(", "async function unusedChrome(")
        .replaceAll("export function startExecutor(", "function unusedExecutor(")
        .replace("export async function startExecutor(", "async function unusedExecutor(")
        .replace("export async function currentUrl(", "async function unusedCurrentUrl(");
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source + "\nexport async function ensureChrome() {}\nexport async function currentUrl() { return \"about:blank\"; }\nexport async function startExecutor(...args) { globalThis.__bopsExecutorCalls.push(args); const running = globalThis.__bopsTaskChildRunning; return { exitCode: running ? null : 0, signalCode: null, kill(signal) { globalThis.__bopsExecutorKills.push({ sessionId: args[0], signal }); }, once() {} }; }") };
    }
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    if (name === "orgo")
      return {
        format: "module",
        shortCircuit: true,
        source: `export const computerAsleepError = () => false; export const computerWakingError = () => false; export const madeByThisServer = () => false; export const madeReady = () => {}; export const wakeWaitMs = () => 1;
export const orgo = { screens: async () => [99,100,101,102].map((d) => ({ display: ":" + d })), bash: async (_id, cmd) => { globalThis.__bopsOrgoCommands.push(cmd); return { exit_code: 0, output: "ok" }; } };\nexport class OrgoError extends Error {}\nexport const screenId = () => "";\n`,
      };
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const source = names
      .map((n) => (n === "watchScreen" ? "export const watchScreen = () => () => {};" : n === "codex" ? "export const codex = globalThis.__bopsTestCodex;" : n === "emptyMac" ? "export const emptyMac = () => ({ ready: false, approvals: [], alwaysApps: [], rules: [] });" : name === "composio" && n === "composioOn" ? "export const composioOn = () => globalThis.__enableNativeApps === true;" : name === "composio" && n === "accountsOf" ? "export const accountsOf = () => globalThis.__enableNativeApps === true ? [{ id: 'fake-account' }] : [];" : name === "composio" && n === "appsKeyFor" ? "export const appsKeyFor = () => 'fake-app-key';" : `export const ${n} = function () { return Promise.resolve(); };`))
      .join("\n");
    return { format: "module", shortCircuit: true, source };
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error(`not a fake: ${url.hostname}`);
  return realFetch(input, init);
};

const agentBodies = [];
const agentInputs = [];
const agentStreams = new Map();
const agentItems = new Map();
const fake = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (req.method === "POST" && url.pathname === "/v1/agents/sessions") {
    agentBodies.push(JSON.parse(raw || "{}"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: `sess_${agentBodies.length}`, environment: { id: `env_${agentBodies.length}`, remote_url: "http://127.0.0.1:9/remote" } }));
    return;
  }
  const path = url.pathname;
  const sid = path.split("/")[4];
  if (req.method === "GET" && path.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    agentStreams.set(sid, res);
    return;
  }
  if (req.method === "POST" && path.endsWith("/events")) {
    agentInputs.push(JSON.parse(raw));
    res.writeHead(202); res.end();
    const stream = agentStreams.get(sid);
    const items = [
      { id: "reason_open", type: "reasoning", summary: [{ text: "Checking the page." }] },
      { id: "nav_open", type: "mcp_call", name: "browser_navigate", arguments: { url: "https://example.com" } },
      { id: "final_open", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "OpenAI Example Domain" }] },
    ];
    agentItems.set(sid, items);
    for (const event of [
      { type: "agent.session.turn.created", turn_id: "open_turn", turn: { subagent_id: null } },
      ...items.map((item) => ({ type: "agent.session.turn.item.done", turn_id: "open_turn", item })),
      { type: "agent.session.turn.completed", turn_id: "open_turn", usage: { input_tokens: 30, output_tokens: 10 } },
    ]) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    stream.end();
    return;
  }
  if (req.method === "GET" && path.endsWith("/items")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [...(agentItems.get(sid) ?? [])].reverse(), has_more: false, object: "list" }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;


const local = await import(`${root}/lib/server/local.ts`);
const store = await import(`${root}/lib/server/store.ts`);
const cloud = await import(`${root}/lib/server/cloud.ts`);
const { CodexLimitError } = await import(`${root}/lib/server/runtime/codex/client.ts`);
const { CodexSignInError } = await import(`${root}/lib/server/runtime/codex/auth.ts`);

// Run the application's session runner first: even without an API key, a Mac browser task
// must get its answer from Codex and persist the result in the chat.
const sessions = await import(`${root}/lib/server/sessions.ts`);
process.env.BOPS_RUNTIME = "codex";
delete process.env.OPENAI_API_KEY;
store.update((s) => {
  s.host = "mac";
  s.bots[0].effort = "medium";
});
const appSession = sessions.startSession({ botId: "boppy", goal: "Open https://example.com and tell me the title.", title: "Example page", where: "cloud", fresh: true });
const until = Date.now() + 2000;
while (Date.now() < until && !ofBefore("turn/start").length && store.session(appSession.id)?.status !== "failed") await new Promise((r) => setTimeout(r, 10));
function ofBefore(method) { return calls.filter((c) => c.method === method); }
const appThread = ofBefore("thread/start").at(-1)?.params;
if (appThread) {
  const threadId = store.session(appSession.id).taskState?.id ?? store.session(appSession.id).codexThread;
  emit(threadId, "item/completed", { item: { id: "answer", type: "agentMessage", text: "Example Domain" } });
  emit(threadId, "turn/completed", { turn: { id: "turn_1", status: "completed" } });
  for (let i = 0; i < 100 && store.session(appSession.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
}
assert.equal(store.session(appSession.id)?.answer, "Example Domain", `Mac tasks on codex must answer without OPENAI_API_KEY (session error: ${store.session(appSession.id)?.error})`);
assert.equal(store.session(appSession.id)?.status, "done");
assert.ok(store.getState().messages.some((m) => m.resultOf === appSession.id && m.text === "Example Domain"), "the task's answer reaches the chat");
assert.equal(agentBodies.length, 0);
// Reply after completion exercises persisted ids, not an in-memory adapter handle.
const savedThread = store.session(appSession.id).taskState?.id ?? store.session(appSession.id).codexThread;
// Force a pre-refactor saved session: the reply must read legacy data and pin its runtime.
store.patchSession(appSession.id, { taskState: undefined, taskRuntime: undefined, codexThread: savedThread, taskTokens: { input: 0, output: 0 } });
sessions.replyToSession(appSession.id, "And its first heading?");
for (let i = 0; i < 100 && ofBefore("turn/start").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(ofBefore("thread/resume").at(-1)?.params.threadId, savedThread);
assert.equal(ofBefore("turn/start").at(-1)?.params.threadId, savedThread);
emit(savedThread, "item/completed", { item: { id: "followup", type: "agentMessage", text: "Example Domain again" } });
emit(savedThread, "turn/completed", { turn: { id: "turn_2", status: "completed" } });
for (let i = 0; i < 100 && store.session(appSession.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(store.session(appSession.id).answer, "Example Domain again");
assert.equal(ofBefore("thread/start").length, 1);
// Stop through the session runner must leave a terminal state and no current turn id.
sessions.replyToSession(appSession.id, "Keep researching.");
for (let i = 0; i < 100 && ofBefore("turn/start").length < 3; i++) await new Promise((r) => setTimeout(r, 10));
sessions.stopSession(appSession.id);
await new Promise((r) => setImmediate(r));
assert.equal(ofBefore("turn/interrupt").at(-1)?.params.threadId, savedThread);
emit(savedThread, "turn/completed", { turn: { id: "turn_3", status: "interrupted" } });
for (let i = 0; i < 100 && store.session(appSession.id)?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(store.session(appSession.id).error, "Stopped by you");
assert.equal(store.session(appSession.id).codexTurn, undefined);
store.update((s) => { s.host = "orgo"; });
const refused = sessions.startSession({ botId: "boppy", goal: "A separate cloud job", where: "cloud", fresh: true });
for (let i = 0; i < 100 && store.session(refused.id)?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
assert.match(store.session(refused.id)?.error ?? "", /BOPS_TASK_RUNTIME=openai/);
assert.equal(store.getState().bots[0].computerStatus, "none", "no Orgo computer was provisioned");
assert.equal(agentBodies.length, 0);
store.update((s) => { s.host = "mac"; });
// An explicit Your Mac task always stays on Codex, even with the OpenAI task runtime selected.
process.env.BOPS_TASK_RUNTIME = "openai";
globalThis.__enableNativeApps = true;
const savedMac = store.getState().mac;
store.update((s) => { s.mac = { ...(s.mac ?? {}), ready: true, reason: undefined }; });
const nativeThreadStarts = ofBefore("thread/start").length;
const nativeTurnStarts = ofBefore("turn/start").length;
const nativeAgentSessions = agentBodies.length;
const nativeSession = sessions.startSession({ botId: "boppy", goal: "Use Calculator", title: "Native runtime policy", where: "mac", fresh: true });
for (let i = 0; i < 300 && ofBefore("thread/start").length === nativeThreadStarts && store.session(nativeSession.id)?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
const nativeThreadParams = ofBefore("thread/start").at(-1)?.params;
assert.ok(nativeThreadParams, `explicit Your Mac starts Codex despite BOPS_TASK_RUNTIME=openai (error: ${store.session(nativeSession.id)?.error})`);
assert.equal(store.session(nativeSession.id)?.taskRuntime, "codex");
assert.equal(agentBodies.length, nativeAgentSessions, "native Your Mac doesn't create an OpenAI Agents session");
const appServer = nativeThreadParams.config.mcp_servers.bops_apps;
assert.equal(appServer.command, process.execPath);
assert.match(appServer.args[0], /(?:^|\/)vm\/apps-mcp\.mjs$/);
assert.notEqual(appServer.args[0], process.execPath, "Node receives the apps MCP script exactly once");
for (let i = 0; i < 100 && ofBefore("turn/start").length === nativeTurnStarts && store.session(nativeSession.id)?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
assert.ok(ofBefore("turn/start").length > nativeTurnStarts, `native task reached Codex turn (error: ${store.session(nativeSession.id)?.error})`);
const nativeThreadId = ofBefore("turn/start").at(-1).params.threadId;
emit(nativeThreadId, "item/completed", { item: { id: "native-policy-answer", type: "agentMessage", text: "Calculator is ready." } });
emit(nativeThreadId, "turn/completed", { turn: { id: `turn_${ofBefore("turn/start").length}`, status: "completed" } });
for (let i = 0; i < 100 && store.session(nativeSession.id)?.status !== "done" && store.session(nativeSession.id)?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(store.session(nativeSession.id)?.answer, "Calculator is ready.", `native task completed (status=${store.session(nativeSession.id)?.status}, error=${store.session(nativeSession.id)?.error})`);
store.update((s) => { s.mac = savedMac; });
globalThis.__enableNativeApps = false;
delete process.env.BOPS_TASK_RUNTIME;
console.log("native selection -> explicit Your Mac stays Codex under OpenAI defaults; apps MCP argv is valid");
console.log("session lifecycle -> persisted thread resumed, stop saved, Orgo refused before provisioning");
// The caller must persist and return an arbitrary continuation, including mid-turn updates.
process.env.BOPS_TASK_RUNTIME = "fixture";
const extra = sessions.startSession({ botId: "boppy", goal: "An extra runtime task", where: "cloud", fresh: true });
for (let i = 0; i < 100 && store.session(extra.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(store.session(extra.id)?.answer, "Fixture revision 1");
assert.deepEqual(store.session(extra.id)?.taskState, { cursor: { page: "next", revision: 1 } }, "an extra runtime's opaque continuation must persist without caller changes");
for (let i = 0; i < 100; i++) {
  const file = join(scratch, ".data/state.json");
  if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).sessions.find((s) => s.id === extra.id)?.taskState?.cursor?.revision === 1) break;
  await new Promise((r) => setTimeout(r, 10));
}
assert.deepEqual(JSON.parse(readFileSync(join(scratch, ".data/state.json"), "utf8")).sessions.find((s) => s.id === extra.id).taskState, { cursor: { page: "next", revision: 1 } });
process.env.BOPS_TASK_RUNTIME = "codex";
sessions.replyToSession(extra.id, "Continue the saved cursor.");
for (let i = 0; i < 100 && store.session(extra.id)?.answer !== "Fixture revision 2"; i++) await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(fixtureOpens.at(-1), { cursor: { page: "next", revision: 1 } }, "a pinned runtime receives its saved continuation after settings change");
assert.equal(store.session(extra.id)?.answer, "Fixture revision 2");
// This runtime supports Orgo and releases its claim by contract rather than a known id.
for (const file of ["vm/bin/bops-screens", "vm/screen_mcp.py"]) {
  mkdirSync(join(scratch, file, ".."), { recursive: true });
  writeFileSync(join(scratch, file), readFileSync(join(root, file)));
}
store.update((s) => { s.host = "orgo"; s.bots[0].computerId = "comp_fixture"; s.bots[0].computerStatus = "ready"; });
process.env.BOPS_TASK_RUNTIME = "fixture";
const extraOrgo = sessions.startSession({ botId: "boppy", goal: "An extra Orgo runtime task", where: "cloud", fresh: true });
for (let i = 0; i < 100 && !orgoCommands.some((cmd) => cmd === `bops-screens release thread:${extraOrgo.id}`); i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(store.session(extraOrgo.id)?.answer, "Fixture revision 1", `Orgo fixture error: ${store.session(extraOrgo.id)?.error}; status: ${store.session(extraOrgo.id)?.status}`);
assert.ok(orgoCommands.some((cmd) => cmd === `bops-screens release thread:${extraOrgo.id}`), "an extra runtime releases Orgo screens through its contract");
store.update((s) => { s.host = "mac"; });
delete process.env.BOPS_TASK_RUNTIME;
// An old Agents continuation without a runtime pin still resumes Agents under a Codex default.
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
store.patchSession(extra.id, { taskState: undefined, taskRuntime: undefined, agentSessionId: "sess_legacy", env: { id: "env_legacy", remoteUrl: "http://127.0.0.1:9/remote" } });
sessions.replyToSession(extra.id, "Read the legacy page.");
for (let i = 0; i < 800 && store.session(extra.id)?.answer !== "OpenAI Example Domain"; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(store.session(extra.id)?.answer, "OpenAI Example Domain", `legacy Agents sessions resume under a different configured runtime; status=${store.session(extra.id)?.status}; error=${store.session(extra.id)?.error}`);
assert.equal(store.session(extra.id)?.taskRuntime, "openai");
assert.equal(store.session(extra.id)?.taskState?.id, "sess_legacy");
assert.equal(store.session(extra.id)?.taskState?.env?.id, "env_legacy");
assert.equal(store.session(extra.id)?.taskState?.env?.remoteUrl, "http://127.0.0.1:9/remote");
assert.equal(store.session(extra.id)?.taskState?.env?.display, 100, "legacy resume records the same Mac display used by its browser tool");
assert.equal(store.session(extra.id)?.taskState?.env?.cdpPort, 19730, "legacy resume pins the browser MCP endpoint to its original Chrome");
assert.equal(agentBodies.length, 0, "legacy Agents continuation does not create a replacement session");
console.log("extensible tasks -> opaque persisted continuation, pinned reply and Orgo release");

// An account swap while a runtime is opening or turning must not let its late callbacks write into
// the new account's session, messages, or task state. The old runtime handle still closes.
process.env.BOPS_TASK_RUNTIME = "fixture";
const swapStateWithSentinel = (sessionId, label) => {
  const box = globalThis.__bops2;
  const next = structuredClone(box.state);
  const old = next.sessions.find((s) => s.id === sessionId);
  assert.ok(old, `session ${sessionId} exists before account swap`);
  next.sessions = next.sessions.map((s) => s.id === sessionId ? {
    ...s, status: "done", endedAt: Date.now(), answer: `${label} answer`, error: undefined,
    taskState: { account: label }, steps: [], replies: [], activity: undefined,
  } : s);
  next.messages = [{ id: `${label}_message`, at: Date.now(), chatId: old.chatId, role: "system", text: `${label} message` }];
  box.state = next;
  box.swaps = (box.swaps ?? 0) + 1;
  box.version++;
};
const waitUntil = async (predicate, message) => {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate(), message);
};
let releaseOpen;
let enteredOpenResolve;
const enteredOpen = new Promise((resolve) => { enteredOpenResolve = resolve; });
fixtureControl.openGate = new Promise((resolve) => { releaseOpen = resolve; });
fixtureControl.openEntered = enteredOpenResolve;
const turnsBeforeOpen = fixtureControl.turns;
const handleBeforeOpen = fixtureHandleId + 1;
const staleOpen = sessions.startSession({ botId: "boppy", goal: "Wait during open", where: "cloud", fresh: true });
await enteredOpen;
swapStateWithSentinel(staleOpen.id, "open-swap");
releaseOpen();
fixtureControl.openGate = null;
fixtureControl.openEntered = null;
await waitUntil(() => fixtureControl.closed.includes(`fixture_handle_${handleBeforeOpen}`), "stale open handle closes");
assert.equal(fixtureControl.turns, turnsBeforeOpen, "a task whose open completed after the swap starts no model turn");
assert.equal(store.session(staleOpen.id)?.answer, "open-swap answer");
assert.deepEqual(store.session(staleOpen.id)?.taskState, { account: "open-swap" });
assert.deepEqual(store.getState().messages.map((m) => m.text), ["open-swap message"]);

store.update((state) => { state.sessions = []; state.messages = []; state.host = "mac"; });
let releaseTurn;
let enteredTurnResolve;
const enteredTurn = new Promise((resolve) => { enteredTurnResolve = resolve; });
fixtureControl.turnGate = new Promise((resolve) => { releaseTurn = resolve; });
fixtureControl.turnEntered = enteredTurnResolve;
const turnsBeforeSwap = fixtureControl.turns;
const handleBeforeTurn = fixtureHandleId + 1;
const staleTurn = sessions.startSession({ botId: "boppy", goal: "Wait during turn", where: "cloud", fresh: true });
await enteredTurn;
swapStateWithSentinel(staleTurn.id, "turn-swap");
releaseTurn();
fixtureControl.turnGate = null;
fixtureControl.turnEntered = null;
await waitUntil(() => fixtureControl.closed.includes(`fixture_handle_${handleBeforeTurn}`), "stale turn handle closes");
assert.equal(fixtureControl.turns, turnsBeforeSwap + 1, "the account swap does not start a replacement task turn");
assert.equal(store.session(staleTurn.id)?.answer, "turn-swap answer");
assert.deepEqual(store.session(staleTurn.id)?.taskState, { account: "turn-swap" }, "late saveState is dropped");
assert.deepEqual(store.session(staleTurn.id)?.steps, [], "late step callback is dropped");
assert.equal(store.session(staleTurn.id)?.activity, undefined, "late caption callback is dropped");
assert.deepEqual(store.getState().messages.map((m) => m.text), ["turn-swap message"], "late completion cannot post into the replacement account");
console.log("account swap -> delayed open/turn callbacks dropped; stale handles closed");

calls.length = 0;
store.update((s) => { s.sessions = []; s.messages = []; s.usage = []; });
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
console.log("session runner -> Mac task answered and saved in chat without an OpenAI key");
if (process.argv.includes("red")) { fake.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
const tasks = await import(`${root}/lib/server/runtime/tasks/index.ts`);

const workspace = local.WORKSPACE;
const instructions = "You are Boppy, the chief of staff bot in Bops.";
const macPlace = { host: "mac", cdpPort: 9300, workspace, sessionId: "ses_adapter" };
const orgoPlace = { host: "orgo", computerId: "comp_test", display: 100, sessionId: "ses_test", botId: "boppy", workspace: "/workspace" };
const macOpen = (extra = {}) => ({ instructions, effort: "medium", place: macPlace, botId: "boppy", ...extra });
const tick = () => new Promise((r) => setImmediate(r));
const of = (method) => calls.filter((c) => c.method === method);

// Exercise the real parser and tool filter without model turns or network access. The fake MCP
// advertises an unsafe tool but has no call handler, so this test never executes host code.
async function actualCodexSafety(params) {
  if (!realCodexBin) { console.log("review CLI safety -> skipped (Codex CLI not installed)"); return; }
  const home = mkdtempSync(join(scratch, "review-codex-"));
  const outside = join(home, "outside-workspace");
  mkdirSync(outside);
  writeFileSync(join(home, "config.toml"), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(outside)}]\nnetwork_access = true\nexclude_slash_tmp = false\nexclude_tmpdir_env_var = false\n`);
  const mcpPath = join(home, "fake-mcp.mjs");
  const sdk = `${root}/node_modules/@modelcontextprotocol/sdk`;
  writeFileSync(mcpPath, `import { Server } from ${JSON.stringify(sdk + "/dist/esm/server/index.js")};
import { StdioServerTransport } from ${JSON.stringify(sdk + "/dist/esm/server/stdio.js")};
import { ListToolsRequestSchema } from ${JSON.stringify(sdk + "/dist/esm/types.js")};
const server = new Server({name:"bops-review-fake",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:["browser_snapshot","browser_run_code_unsafe"].map(name=>({name,description:name,inputSchema:{type:"object",properties:{}}}))}));
await server.connect(new StdioServerTransport());`);
  const proc = spawn(realCodexBin, ["app-server"], { cwd: workspace, detached: true, stdio: ["pipe", "pipe", "ignore"], env: {
    PATH: process.env.PATH, CODEX_HOME: home, TMPDIR: home,
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
    CODEX_DISABLE_AUTOUPDATER: "1", CODEX_DISABLE_SENTRY: "1",
  } });
  let buffer = "", next = 1;
  const waiting = new Map();
  const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CLI safety timeout: ${method}`)); }, 20000);
    waiting.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line); const done = waiting.get(m.id);
      if (done) { waiting.delete(m.id); done(m); }
    }
  });
  let threadId;
  try {
    await request("initialize", { clientInfo: { name: "bops-task-safety-test", version: "1" }, capabilities: {} });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const read = await request("config/read", { cwd: workspace });
    assert.equal(read.config.sandbox_workspace_write.network_access, true, "fixture loaded broad temporary user config");
    assert.deepEqual(read.config.sandbox_workspace_write.writable_roots, [outside]);
    const threadParams = { ...params, config: { ...params.config, plugins: {}, mcp_servers: {
      browser: { ...params.config.mcp_servers.browser, command: process.execPath, args: [mcpPath], cwd: workspace },
    } } };
    const started = await request("thread/start", threadParams);
    threadId = started.thread.id;
    const inventory = await request("mcpServerStatus/list", { threadId, serverName: "browser", detail: "full" });
    const browser = inventory.data.find((s) => s.name === "browser");
    assert.equal(browser.runtimeStatus, "connected"); assert.equal(browser.toolsError, null);
    return { sandbox: started.sandbox, tools: Object.keys(browser.tools) };
  } finally {
    if (threadId) await request("thread/unsubscribe", { threadId }).catch(() => {});
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
    if (proc.pid) try { process.kill(-proc.pid, "SIGTERM"); } catch {}
    await exited;
  }
}

// Regressions from independent tasks review; focused modes preserve RED/GREEN evidence.
const reviewRegressions = {
  async "review-allowlist"() {
    const rt = tasks.macTasksRuntime();
    const thread = await rt.open(macOpen());
    try {
      const params = of("thread/start").at(-1).params;
      const browser = params.config.mcp_servers.browser;
      assert.ok(Array.isArray(browser.enabled_tools), "bot browser must expose an explicit tool allowlist, not the unsafe core set");
      assert.ok(browser.enabled_tools.includes("browser_navigate"));
      assert.ok(browser.enabled_tools.includes("browser_snapshot"));
      assert.ok(browser.enabled_tools.includes("browser_take_screenshot"), "visual browser tasks must retain safe screenshots");
      assert.equal(browser.enabled_tools.includes("browser_run_code_unsafe"), false, "host JavaScript must not be exposed or auto-approved");
      assert.equal(browser.enabled_tools.includes("browser_install"), false);
      assert.equal(browser.enabled_tools.includes("browser_file_upload"), false);
      const effective = await actualCodexSafety(params);
      if (effective) {
        assert.ok(effective.tools.includes("browser_snapshot"));
        assert.equal(effective.tools.includes("browser_run_code_unsafe"), false, "real Codex filters the unsafe tool before exposure");
      }
      console.log("review-allowlist -> browser navigation available; host code not exposed/approved");
    } finally { await rt.close(thread); }
  },
  async "review-sandbox"() {
    const rt = tasks.macTasksRuntime();
    for (const resume of [undefined, { id: "thr_saved" }]) {
      const thread = await rt.open(macOpen({ resume }));
      try {
        const params = of(resume ? "thread/resume" : "thread/start").at(-1).params;
        assert.deepEqual(params.config.sandbox_workspace_write, { writable_roots: [], network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true }, "bot thread must reset broad inherited roots/network/tmp permissions");
        if (!resume) {
          const effective = await actualCodexSafety(params);
          if (effective) {
            const narrow = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
            assert.deepEqual(effective.sandbox, narrow, "real parser must not inherit broad temporary user policy");
          }
        }
      } finally { await rt.close(thread); }
    }
    const native = await rt.open(macOpen({ native: true }));
    assert.equal(of("thread/start").at(-1).params.config.sandbox_workspace_write, undefined, "native app approvals retain their policy");
    await rt.close(native);
    console.log("review-sandbox -> broad owner permissions reset on start/resume; native unchanged");
  },
  async "review-limit"() {
    const rt = tasks.macTasksRuntime();
    const thread = await rt.open(macOpen());
    try {
      const pending = rt.turn({ thread, input: "Read the page", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: { step() {}, caption() {}, isStopped: () => false, bindStop() {} } });
      const result = pending.catch((e) => e);
      await tick();
      emit(thread.id, "turn/completed", { turn: { status: "failed", error: { codexErrorInfo: "rateLimitExceeded", message: "Request could not be completed", resets_in_seconds: 60 } } });
      const error = await result;
      assert.ok(error instanceof CodexLimitError, `structured rateLimitExceeded must use the plan-limit path; got ${error.constructor.name}: ${error.message}`);
      assert.equal(cloud.noteOutOfCredit(error), true);
      assert.match(cloud.creditNote(error), /ChatGPT Pro plan/);
      assert.equal(store.getState().credits, undefined);
      console.log("review-limit -> structured rateLimitExceeded uses plan-limit handling");
    } finally { await rt.close(thread); }
  },
  async "review-phase"() {
    const rt = tasks.macTasksRuntime();
    const thread = await rt.open(macOpen({ native: true }));
    const steps = [], captions = [];
    try {
      const pending = rt.turn({ thread, input: "Use Calculator", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: {
        step: (tool, detail) => steps.push({ tool, detail }), caption: (text) => captions.push(text), isStopped: () => false, bindStop() {},
        removeLastNote: (text) => { if (steps.at(-1)?.tool === "note" && steps.at(-1).detail === text) steps.pop(); },
      } });
      await tick();
      emit(thread.id, "item/completed", { item: { id: "narration", type: "agentMessage", text: "Opening Calculator now" } });
      assert.deepEqual(steps, [{ tool: "note", detail: "Opening Calculator now" }], "native intermediate message without phase must appear live as a step");
      assert.equal(captions.at(-1), "Opening Calculator now", "native narration must be a live caption");
      emit(thread.id, "item/started", { item: { id: "calculation", type: "mcpToolCall", server: "cua_repl", tool: "js", arguments: { title: "Calculate 7 times 8" } } });
      emit(thread.id, "item/completed", { item: { id: "final", type: "agentMessage", text: "56" } });
      emit(thread.id, "turn/completed", { turn: { status: "completed" } });
      assert.equal(await pending, "56");
      assert.deepEqual(steps, [{ tool: "note", detail: "Opening Calculator now" }, { tool: "computer", detail: "Calculate 7 times 8" }], "only the final answer note is removed");
      console.log("review-phase -> native missing-phase narration is live; final answer removed from notes");
    } finally { await rt.close(thread); }
  },
};
if (reviewRegressions[process.argv[2]]) {
  await reviewRegressions[process.argv[2]]();
  fake.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(0);
}

/* ---------------- Which runtime runs tasks ---------------- */

{
  delete process.env.BOPS_RUNTIME;
  delete process.env.BOPS_TASK_RUNTIME;
  assert.doesNotThrow(() => tasks.tasksRuntime().assertHost("orgo"), "openai runs a cloud computer");
  process.env.BOPS_TASK_RUNTIME = "nope";
  assert.throws(() => tasks.tasksRuntime(), /Unknown runtime "nope" in BOPS_TASK_RUNTIME/);
  delete process.env.BOPS_TASK_RUNTIME;
  process.env.BOPS_RUNTIME = "codex";
  assert.throws(() => tasks.tasksRuntime().assertHost("orgo"), /BOPS_TASK_RUNTIME=openai/);
  process.env.BOPS_TASK_RUNTIME = "openai";
  assert.doesNotThrow(() => tasks.tasksRuntime().assertHost("orgo"), "BOPS_TASK_RUNTIME wins over BOPS_RUNTIME");
  delete process.env.BOPS_TASK_RUNTIME;
  console.log("selection -> openai by default, codex refuses a cloud computer, per-capability override");
}

/* ---------------- A Mac task on the Codex app-server ---------------- */

{
  const rt = tasks.tasksRuntime();
  const steps = [];
  const captions = [];
  process.env.BOPS_SESSION_MODEL = "";
  const thread = await rt.open(macOpen());
  delete process.env.BOPS_SESSION_MODEL;
  assert.equal(thread.id, "thr_1");
  const started = of("thread/start").at(-1).params;
  assert.equal(started.model, "gpt-6.1-sol");
  assert.equal(started.cwd, workspace);
  assert.equal(started.approvalPolicy, "never");
  assert.equal(started.sandbox, "workspace-write");
  assert.equal(started.developerInstructions, instructions);
  assert.equal(started.serviceName, "Bops");
  assert.equal(started.config.web_search, "live");
  assert.equal(started.config.mcp_servers.personal_browser.enabled, false);
  assert.equal(started.config.plugins["other@test"].enabled, false);
  assert.equal(started.config.project_doc_max_bytes, 0);
  assert.deepEqual(started.config.skills.config, [{ path: "/tmp/private-skill/SKILL.md", enabled: false }, { path: "/tmp/computer-use/SKILL.md", enabled: false }]);
  assert.deepEqual(started.config.mcp_servers.browser, local.browserServer(9300, workspace));
  assert.equal(agentBodies.length, 0, "the Agents API wasn't asked");
  try {
    const hooks = () => ({
      step: (tool, detail) => steps.push({ tool, detail }),
      caption: (text) => captions.push(text),
      isStopped: () => false,
      bindStop: () => {},
    });
    const first = rt.turn({ thread, input: "Open https://example.com and tell me the title.", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: hooks() });
    await tick();
    const turn = of("turn/start").at(-1).params;
    assert.equal(turn.threadId, "thr_1");
    assert.equal(turn.model, "gpt-6.1-sol");
    assert.equal(turn.effort, "medium");
    assert.equal(turn.summary, "auto");
    assert.deepEqual(turn.input, [{ type: "text", text: "Open https://example.com and tell me the title." }]);
    emit("thr_1", "item/reasoning/summaryTextDelta", { delta: "Checking the example page. " });
    emit("thr_1", "item/started", { item: { id: "nav", type: "mcpToolCall", server: "browser", tool: "browser_navigate", arguments: { url: "https://example.com" } } });
    emit("thr_1", "item/completed", { item: { id: "ws1", type: "webSearch", action: { type: "search", query: "example domain" } } });
    emit("thr_1", "item/started", { item: { id: "cmd", type: "commandExecution", command: "ls" } });
    emit("thr_1", "item/completed", { item: { id: "msg", type: "agentMessage", text: "Example Domain" } });
    emit("thr_1", "thread/tokenUsage/updated", {
      turnId: "turn_1",
      tokenUsage: {
        last: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        total: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningOutputTokens: 0 },
      },
    });
    emit("thr_1", "thread/tokenUsage/updated", {
      turnId: "turn_1",
      tokenUsage: { last: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningOutputTokens: 0 } },
    });
    emit("thr_1", "turn/completed", { turn: { id: "turn_1", status: "completed" } });
    assert.equal(await first, "Example Domain");
    assert.equal(captions.at(-1), "checking the example page");
    assert.deepEqual(
      steps.map((s) => `${s.tool}: ${s.detail}`),
      ["browser_navigate: opened https://example.com", `search: searched "example domain"`, "command: ran ls"],
    );
    const usage = store.getState().usage?.filter((e) => e.kind === "model.tokens" && e.source === "session") ?? [];
    assert.equal(usage.length, 1, "the same turn's usage is recorded once");
    assert.equal(usage[0].model, "gpt-6.1-sol");
    assert.equal(usage[0].inputTokens, 100);
    assert.equal(usage[0].outputTokens, 20);

    const second = rt.turn({ thread, input: "And the heading under it?", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: hooks() });
    await tick();
    assert.equal(of("thread/start").length, 1, "the reply stays on the thread");
    assert.equal(of("turn/start").at(-1).params.threadId, "thr_1");
    emit("thr_1", "thread/tokenUsage/updated", { turnId: "turn_2", tokenUsage: { last: { inputTokens: 100, outputTokens: 30 }, total: { inputTokens: 200, outputTokens: 50 } } });
    emit("thr_1", "thread/tokenUsage/updated", { turnId: "turn_2", tokenUsage: { last: { inputTokens: 150, outputTokens: 50 }, total: { inputTokens: 350, outputTokens: 100 } } });
    emit("thr_1", "thread/tokenUsage/updated", { turnId: "turn_2", tokenUsage: { last: { inputTokens: 150, outputTokens: 50 }, total: { inputTokens: 350, outputTokens: 100 } } });
    emit("thr_1", "item/completed", { item: { id: "msg2", type: "agentMessage", text: "Example Domain, still." } });
    emit("thr_1", "turn/completed", { turn: { id: "turn_2", status: "completed" } });
    assert.equal(await second, "Example Domain, still.");
    const entries = store.getState().usage.filter((e) => e.kind === "model.tokens" && e.source === "session");
    assert.equal(entries.length, 3, "each distinct inference counted, duplicate snapshot ignored");
    assert.equal(entries.reduce((n, e) => n + e.inputTokens, 0), 350);
    assert.equal(entries.reduce((n, e) => n + e.outputTokens, 0), 100);
    const restored = await rt.open(macOpen({ resume: { id: thread.id, tokens: thread.tokens } }));
    const third = rt.turn({ thread: restored, input: "After restarting?", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: hooks() });
    await tick();
    emit(thread.id, "thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 50, outputTokens: 10 }, total: { inputTokens: 400, outputTokens: 110 } } });
    emit(thread.id, "item/completed", { item: { id: "msg3", type: "agentMessage", text: "Same thread" } });
    emit(thread.id, "turn/completed", { turn: { status: "completed" } });
    assert.equal(await third, "Same thread");
    assert.equal(store.getState().usage.filter((e) => e.kind === "model.tokens" && e.source === "session").reduce((n, e) => n + e.inputTokens, 0), 400, "resume counts only fresh tokens");
    await rt.close(restored);

    console.log("codex mac -> steps, caption, answer, second turn, tokens");
  } finally {
    await rt.close(thread);
  }
}

/* ---------------- Stop ---------------- */

{
  const rt = tasks.tasksRuntime();
  const thread = await rt.open(macOpen());
  try {
    let stop = () => {};
    const pending = rt.turn({
      thread,
      input: "Keep going forever.",
      effort: "low",
      botId: "boppy",
      epoch: store.stateEpoch(),
      hooks: { step() {}, caption() {}, isStopped: () => false, bindStop: (fn) => (stop = fn) },
    });
    await tick();
    stop();
    await tick();
    const hit = of("turn/interrupt").at(-1);
    assert.equal(hit?.params.threadId, thread.id);
    assert.equal(hit?.params.turnId, `turn_${of("turn/start").length}`);
    emit(thread.id, "turn/completed", { turn: { status: "interrupted" } });
    await assert.rejects(pending, { message: "Stopped by you" });
    console.log("stop -> turn/interrupt, Stopped by you");
  } finally {
    await rt.close(thread);
  }
}

/* ---------------- Resume after the server restarted ---------------- */

{
  const rt = tasks.tasksRuntime();
  const again = await rt.open(macOpen({ resume: { id: "thr_saved" } }));
  try {
    assert.equal(again.id, "thr_saved");
    const resumed = of("thread/resume").at(-1).params;
    assert.equal(resumed.threadId, "thr_saved");
    assert.equal(resumed.developerInstructions, instructions);
    assert.equal(resumed.config.web_search, "live");
    assert.deepEqual(resumed.config.mcp_servers.browser, local.browserServer(9300, workspace));
    assert.equal(of("thread/start").length, 2, "a saved thread is resumed, not started over");
    console.log("resume -> thread/resume keeps the browser and the instructions");
  } finally {
    await rt.close(again);
  }
}

/* ---------------- Cloud computer, and no ChatGPT sign-in ---------------- */

{
  const rt = tasks.tasksRuntime();
  const before = calls.length;
  await assert.rejects(() => rt.open({ instructions, effort: "medium", place: orgoPlace, botId: "boppy" }), (e) => /BOPS_TASK_RUNTIME=openai/.test(e.message) && !(e instanceof CodexLimitError));
  assert.equal(calls.length, before, "no thread was started for a cloud computer");
  rmSync(authPath);
  await assert.rejects(() => rt.open(macOpen()), (e) => e instanceof CodexSignInError && /Settings → This Mac/.test(e.message));
  assert.equal(calls.length, before, "signed out: the app-server wasn't asked");
  signIn();
  console.log("orgo -> refused, use BOPS_TASK_RUNTIME=openai; signed out -> Settings → This Mac");
}

/* ---------------- The plan's limit ---------------- */

{
  const rt = tasks.tasksRuntime();
  const thread = await rt.open(macOpen());
  try {
    const pending = rt.turn({ thread, input: "Do the long one.", effort: "high", botId: "boppy", epoch: store.stateEpoch(), hooks: { step() {}, caption() {}, isStopped: () => false, bindStop() {} } });
    await tick();
    assert.equal(of("turn/start").at(-1).params.model, "gpt-6-astra", "high effort uses the hard model");
    emit(thread.id, "turn/completed", { turn: { status: "failed", error: { message: "The usage limit has been reached", code: "usage_limit_reached" } } });
    const error = await pending.then(
      () => assert.fail("the limit came back as an answer"),
      (e) => e,
    );
    assert.ok(error instanceof CodexLimitError, error?.message);
    assert.match(error.message, /your ChatGPT Pro plan/);
    assert.equal(cloud.noteOutOfCredit(error), true);
    assert.equal(cloud.creditNote(error), error.message);
    assert.equal(store.getState().credits, undefined, "not Bops Cloud's credit");
    console.log("limit ->", error.message);
  } finally {
    await rt.close(thread);
  }
}

/* ---------------- Bops Cloud's AI credit gates only the OpenAI runtime ---------------- */

{
  process.env.BOPS_SELF_HOSTED = "0";
  globalThis.bopsOrgoKey = "orgo-test-not-a-real-key";
  store.update((s) => (s.credits = { out: true, at: Date.now() }));
  process.env.BOPS_RUNTIME = "codex";
  delete process.env.BOPS_TASK_RUNTIME;
  assert.equal(await tasks.tasksOutOfCredit(), false, "the plan isn't Bops Cloud's credit");
  process.env.BOPS_TASK_RUNTIME = "openai";
  assert.equal(await tasks.tasksOutOfCredit(), true, "openai through the cloud still pauses");
  store.update((s) => (s.credits = undefined));
  globalThis.bopsOrgoKey = null;
  process.env.BOPS_SELF_HOSTED = "1";
  delete process.env.BOPS_TASK_RUNTIME;
  process.env.BOPS_RUNTIME = "codex";
  console.log("cloud credit -> codex tasks go on, openai through the cloud pauses");
}

/* ---------------- OpenAI's Agents API, unchanged ---------------- */

{
  process.env.BOPS_TASK_RUNTIME = "openai";
  const before = calls.length;
  const rt = tasks.tasksRuntime();
  const mac = await rt.open(macOpen());
  try {
    const body = agentBodies.at(-1);
    assert.equal(body.agent.model, "gpt-6.1-sol");
    assert.deepEqual(body.agent.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(body.agent.instructions, instructions);
    assert.equal(body.agent.tools[0].type, "web_search");
    assert.equal(body.agent.tools[0].mode, "live");
    assert.equal(body.agent.tools.length, 2, "web search and the browser, no screen tools");
    assert.equal(body.agent.tools[1].server_label, "browser");
    assert.equal(body.agent.tools[1].required, true);
    assert.deepEqual(body.agent.tools[1].transport, local.browserMcp(9300, local.taskDir("ses_adapter")));
    assert.deepEqual(body.agent.tools[1].allowed_tools, local.MAC_BROWSER_TOOLS, "OpenAI Mac browser keeps the upstream sandbox tool allowlist");
    assert.equal(executorCalls.at(-1)[0], "ses_adapter");
    assert.equal(executorCalls.at(-1)[4], local.taskDir("ses_adapter"));
    assert.equal(executorCalls.at(-1)[5], false, "adapter retains sandbox unless Full access is enabled");
    assert.equal(body.agent.multi_agent, undefined);
    assert.equal(body.environment.type, "self_hosted");
    assert.equal(body.environment.workspace_directory, workspace);
    assert.equal(mac.env?.id, "env_1");
    const steps = [], captions = [];
    const answer = await rt.turn({ thread: mac, input: "Read the example", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: { step: (tool, detail) => steps.push({ tool, detail }), caption: (line) => captions.push(line), isStopped: () => false, bindStop() {} } });
    assert.equal(answer, "OpenAI Example Domain");
    assert.deepEqual(steps, [{ tool: "browser_navigate", detail: "opened https://example.com" }]);
    assert.equal(captions.at(-1), "checking the page");
    assert.deepEqual(agentInputs.at(-1), { events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "Read the example" }] }] }] });

  } finally {
    await rt.close(mac);
  }
  const cloudThread = await rt.open({ instructions, effort: "high", place: orgoPlace, botId: "boppy" });
  try {
    const body = agentBodies.at(-1);
    assert.equal(body.agent.model, "gpt-6-astra");
    assert.deepEqual(body.agent.reasoning, { effort: "high", summary: "auto" });
    assert.equal(body.agent.tools.length, 3);
    assert.equal(body.agent.tools[1].server_label, "browser");
    assert.equal(body.agent.tools[1].required, false);
    assert.ok(body.agent.tools[1].transport.args.includes("http://127.0.0.1:9300"));
    assert.equal(body.agent.tools[2].server_label, "screen");
    assert.equal(body.agent.tools[2].required, true);
    assert.deepEqual(body.agent.tools[2].transport.args, ["/opt/bops/screen_mcp.py", "stdio", "--session", "ses_test", "--bot", "boppy"]);
    assert.deepEqual(body.agent.multi_agent, { enabled: true, max_concurrent_subagents: 3 });
    assert.equal(body.environment.workspace_directory, "/workspace");
    assert.ok(cloudThread.env?.remoteUrl);
  } finally {
    await rt.close(cloudThread);
  }
  // New upstream Orgo sessions use Responses' computer tool, while saved Agents threads stay Agents.
  process.env.BOPS_COMPUTER_TOOL = "1";
  const agentsBeforeComputer = agentBodies.length;
  const computer = await rt.open({ instructions, effort: "medium", place: orgoPlace, botId: "boppy" });
  try {
    assert.equal(agentBodies.length, agentsBeforeComputer, "computer runner does not create an Agents session");
    assert.deepEqual(rt.snapshot(computer), { runner: "computer" });
    assert.deepEqual(rt.resume({ taskState: rt.snapshot(computer) }), { runner: "computer" });
    assert.equal(rt.usesComputerTool({ runner: "computer" }, orgoPlace), true);
    assert.equal(rt.usesComputerTool({ agentSessionId: "legacy", env: { id: "legacy-env", remoteUrl: "http://127.0.0.1:9" } }, orgoPlace), false, "legacy Agents session keeps its runner");
    assert.equal(rt.usesComputerTool({}, macPlace), false, "Responses computer runner stays on Orgo");
  } finally {
    await rt.close(computer);
    process.env.BOPS_COMPUTER_TOOL = "0";
  }
  assert.equal(calls.length, before, "openai doesn't start a Codex thread");
  console.log("openai -> Agents session unchanged (mac browser, orgo helpers)");
}

// A stale OpenAI close still kills its child, but cannot remove the replacement's shared task folder.
{
  process.env.BOPS_TASK_RUNTIME = "openai";
  globalThis.__bopsTaskChildRunning = true;
  const rt = tasks.tasksRuntime();
  const ownerPlace = { ...macPlace, sessionId: "ses_owner" };
  const first = await rt.open(macOpen({ sessionId: "ses_owner", place: ownerPlace }));
  const second = await rt.open(macOpen({ sessionId: "ses_owner", place: ownerPlace, resume: { id: first.id, env: first.env } }));
  const folder = local.taskDir("ses_owner");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "replacement-owner.txt"), "keep");
  const killedBefore = executorKills.length;
  await rt.close(first);
  assert.equal(executorKills.length, killedBefore + 1, "stale close still kills its own executor child");
  assert.equal(readFileSync(join(folder, "replacement-owner.txt"), "utf8"), "keep", "stale close cannot remove the replacement task folder");
  await rt.close(second);
  assert.equal(existsSync(folder), false, "current owner removes its task folder on close");
  globalThis.__bopsTaskChildRunning = false;
  console.log("OpenAI lifecycle -> stale close kills its executor, preserves replacement folder");
}

// Orgo cleanup is owned by the current task for a display; a stale handle must not kill its replacement.
{
  process.env.BOPS_TASK_RUNTIME = "openai";
  const rt = tasks.tasksRuntime();
  const sessionId = "ses_orgo_owner";
  const place = { ...orgoPlace, sessionId };
  const first = await rt.open({ instructions, effort: "medium", place, sessionId, botId: "boppy" });
  const second = await rt.open({ instructions, effort: "medium", place, sessionId, botId: "boppy" });
  const beforeClose = orgoCommands.length;
  await rt.close(first);
  const staleCleanup = orgoCommands.at(-1) ?? "";
  assert.equal(orgoCommands.length, beforeClose, "a stale Orgo close must not send cleanup for the replacement's display");
  assert.doesNotMatch(staleCleanup, /pkill/);
  await rt.close(second);
  const ownerCleanup = orgoCommands.at(-1) ?? "";
  assert.match(ownerCleanup, /if \[ "\$\(cat .*executor-owner-100.*\)" = /, "current owner checks its generation under the display lock");
  assert.match(ownerCleanup, /pkill -f/);
  assert.match(ownerCleanup, /rm -f .*executor-key-100/);
  console.log("Orgo lifecycle -> stale close cannot kill a replacement sharing the display");
}

// Your Mac shares the adapter while preserving native app approvals.
{
  const rt = tasks.macTasksRuntime();
  const thread = await rt.open(macOpen({ native: true }));
  const params = of("thread/start").at(-1).params;
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "user");
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.config.mcp_servers, undefined, "no bot browser on Your Mac");
  const targets = [];
  const nativeSessionId = "ses_native_approval_contract";
  store.update((s) => { s.sessions.push({ id: nativeSessionId, botId: "boppy", chatId: "bot:boppy", title: "Native approval contract", goal: "Use Calculator", host: "mac", runsOn: "mac", status: "running", steps: [], replies: [], taskState: rt.snapshot(thread) }); });
  const pending = rt.turn({ thread, sessionId: nativeSessionId, input: "Use Calculator", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: { step() {}, caption() {}, isStopped: () => false, bindStop() {}, computer: (apps, target) => targets.push({ apps, target }) } });
  await tick();
  const approvalRouter = (await import(`${root}/lib/server/codex.ts?approval-contract`)).codex;
  await approvalRouter.ask({ id: "native-command", method: "item/commandExecution/requestApproval", params: { threadId: thread.id, command: "calculator-check" } });
  await approvalRouter.ask({ id: "native-app", method: "mcpServer/elicitation/request", params: { threadId: thread.id, serverName: "computer_use", message: 'Allow use "Messages"' } });
  for (const approval of store.getState().mac.approvals) {
    assert.equal(approval.sessionId, nativeSessionId, "native app approvals retain their session association after opaque persistence");
    assert.equal(approval.botId, "boppy");
  }
  assert.equal(store.getState().mac.approvals.length, 2);
  emit(thread.id, "item/started", { item: { id: "native", type: "mcpToolCall", server: "cua_repl", tool: "js", arguments: { code: 'await cua.getApp("Calculator")', title: "Open Calculator" } } });
  emit(thread.id, "item/completed", { item: { id: "native_answer", type: "agentMessage", text: "4" } });
  emit(thread.id, "turn/completed", { turn: { status: "completed" } });
  assert.equal(await pending, "4");
  assert.deepEqual(targets[0].apps, ["Calculator"]);
  await rt.close(thread);
  console.log("Your Mac -> native approvals, app targets, answer through the task interface");
}

// Resuming the same Codex thread claims it before async work; the stale handle cannot off/unsubscribe it.
{
  const rt = tasks.macTasksRuntime();
  const sessionId = "ses_codex_owner";
  const place = { ...macPlace, sessionId };
  const first = await rt.open(macOpen({ native: true, sessionId, place }));
  const second = await rt.open(macOpen({ native: true, sessionId, place, resume: rt.snapshot(first) }));
  const unsubscribedBefore = of("thread/unsubscribe").length;
  const listener = () => {};
  globalThis.__bopsTestCodex.listenerMap.set(first.id, listener);
  await rt.close(first);
  assert.equal(globalThis.__bopsTestCodex.listenerMap.get(first.id), listener, "stale close cannot remove the resumed thread's listener");
  assert.equal(of("thread/unsubscribe").length, unsubscribedBefore, "stale close cannot unload the resumed thread");
  await rt.close(second);
  assert.equal(globalThis.__bopsTestCodex.listenerMap.has(second.id), false, "current close removes its listener");
  assert.equal(of("thread/unsubscribe").length, unsubscribedBefore + 1, "current close unloads its thread");
  console.log("Codex lifecycle -> resumed-thread ownership protects listeners and unsubscribe");
}

// Stopping before turn/start responds, including a terminal event before that response.
for (const completesEarly of [false, true]) {
  const rt = tasks.macTasksRuntime();
  const thread = await rt.open(macOpen());
  let stop;
  holdNextTurn = true;
  const pending = rt.turn({ thread, input: "Wait", effort: "medium", botId: "boppy", epoch: store.stateEpoch(), hooks: { step() {}, caption() {}, isStopped: () => false, bindStop: (fn) => stop = fn } });
  const result = pending.then(() => "unexpected success", (e) => e.message);
  await tick();
  const before = of("turn/interrupt").length;
  stop();
  assert.equal(of("turn/interrupt").length, before, "waits for the turn id");
  if (completesEarly) emit(thread.id, "turn/completed", { turn: { status: "interrupted" } });
  heldTurn({ turn: { id: "late_turn" } });
  await tick();
  assert.equal(of("turn/interrupt").at(-1).params.turnId, "late_turn");
  if (!completesEarly) emit(thread.id, "turn/completed", { turn: { status: "interrupted" } });
  assert.equal(await result, "Stopped by you");
  await rt.close(thread);
}
console.log("stop race -> queued interrupt delivered after a late turn id, no stale listener");

for (const regression of Object.values(reviewRegressions)) await regression();

console.log("all runtime task tests passed (fake app-server, fake Agents API, none to the network)");
fake.close();
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
