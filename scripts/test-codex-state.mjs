// A native Codex check or approval that awaited work must not land in another account's state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ts = createRequire(import.meta.url)("typescript");
let epoch = 0;
let state = { sessions: [{ id: "old-session", chatId: "old-chat", botId: "bot", codexThread: "old-thread", goal: "old task" }], mac: { approvals: [], alwaysApps: [] } };
const messages = [];
let finishJudgment;
let judgmentStarted;
const entered = new Promise(resolve => { judgmentStarted = resolve; });
globalThis.__codexStateTest = {
  selectedChecks: 0,
  getState: () => state,
  update: fn => fn(state),
  addMessage: m => messages.push(m),
  stateEpoch: () => epoch,
  sameState: () => { const before = epoch; return () => epoch === before; },
  lowRisk: () => { judgmentStarted(); return new Promise(resolve => { finishJudgment = resolve; }); },
};
const fake = `const f = globalThis.__codexStateTest;
export const getState = f.getState, update = f.update, addMessage = f.addMessage, stateEpoch = f.stateEpoch, sameState = f.sameState, lowRisk = f.lowRisk;
export const stateReady = () => true;
export const checkMac = async () => { f.selectedChecks++; };
export const bot = () => ({name:"Bot"});
export const id = () => "approval";
export const ownerName = () => "the user";
export const TALKING_APPS = /^Messages$/;
export const agentEnv = x => x;
export const onPostgres = () => false;
export const codexHome = () => "/nonexistent-codex-test-home";
export const codexPath = () => "/none";
export const findCodex = () => "/fake/codex";
export const installStatus = () => undefined;
export const installCodex = () => {throw Error("not used")};`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try { return next(specifier, context); } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier)) return next(specifier + ".ts", context);
      throw e;
    }
  },
  load(url, context, next) {
    if (!url.startsWith(pathToFileURL(root).href) || !url.endsWith(".ts")) return next(url, context);
    if (!url.endsWith("/lib/server/codex.ts")) return { format: "module", source: fake, shortCircuit: true };
    return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
  },
});
const { codex, checkMac } = await import(`${root}/lib/server/codex.ts`);
const answers = [];
codex.respond = (...a) => answers.push(a);
const pending = codex.ask({ id: 1, method: "mcpServer/elicitation/request", params: { threadId: "old-thread", message: 'use "Calculator"' } });
await entered;
epoch++;
state = { sessions: [], mac: { ready: true, approvals: [], alwaysApps: [] } };
finishJudgment(true);
await pending;
assert.deepEqual(messages, [], "old account judgment must not append a message in new account");
assert.deepEqual(state.mac.approvals, [], "old thread creates no orphan approval");
assert.deepEqual(answers, [[1, { action: "decline", content: null }]], "stale request is refused");
let finishCheck;
codex.ready = () => new Promise(resolve => { finishCheck = resolve; });
codex.request = async () => ({account:{type:"chatgpt",planType:"test"}});
const checking = checkMac();
epoch++;
state = { sessions: [], mac: { ready: true, approvals: [], alwaysApps: [], reason: "new account" } };
const before = JSON.stringify(state);
finishCheck();
await checking;
assert.equal(JSON.stringify(state), before, "old readiness check must not write into new account");
codex.signedIn({ success: true });
await new Promise(resolve => setImmediate(resolve));
assert.equal(globalThis.__codexStateTest.selectedChecks, 1, "login completion refreshes the selected runtime");
console.log("codex-state: delayed native judgment and readiness stay in their original account");
