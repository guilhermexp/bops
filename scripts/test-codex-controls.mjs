// The merged Mac controls must keep Codex approval/sign-in and upstream Full access guards.
// All providers and state are fakes; no Keychain, Codex process, browser or network is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ts = createRequire(import.meta.url)("typescript");
const state = { mac: { rules: [], alwaysApps: ["Calculator"], approvals: [] } };
const calls = [];
const readiness = [];
let ready = true;
let local = true;
let window = false;
globalThis.__codexControls = { state, calls, readiness, ready: () => ready, local: () => local, window: () => window };
const fake = `const f = globalThis.__codexControls;
export const answer = (...a) => f.calls.push(["answer", ...a]);
export const checkMac = async () => true;
export const retryCodex = async () => f.calls.push(["install"]);
export const signInToCodex = async () => f.calls.push(["sign-in"]);
export const openCodexApp = () => f.calls.push(["open"]);
export const DEFAULT_MAC_RULES = ["Notes"];
export const emptyMac = () => ({rules:[], approvals:[], alwaysApps:[]});
export const fromThisMac = () => f.local();
export const fromBopsWindow = () => f.window();
export const getState = () => f.state;
export const update = fn => fn(f.state);
export const notReady = () => f.ready() ? null : Response.json({}, {status:409});
export const setFullAccess = on => f.calls.push(["fullAccess", on]);
export const findCodex = () => "/fake/codex";
export const installStatus = () => undefined;`;
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
    if (url.includes("/lib/server/")) return { format: "module", source: fake.replace("export const checkMac = async () => true;", `export const checkMac = async () => f.readiness.push("${url.endsWith("/mac.ts") ? "selected" : "native"}");`), shortCircuit: true };
    return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
  },
});
const mac = await import(`${root}/app/api/mac/route.ts`);
const codex = await import(`${root}/app/api/mac/codex/route.ts`);
const req = body => new Request("http://localhost/api/mac", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
assert.equal((await mac.POST(req({ id: "approval", decision: "once" }))).status, 200, "Codex app approval remains answerable");
assert.deepEqual(calls.pop(), ["answer", "approval", "once"]);
assert.equal((await mac.POST(req({ id: "approval", decision: "anything" }))).status, 400);
for (const action of ["sign-in", "open", "install"]) {
  assert.equal((await codex.POST(req({ action }))).status, 200, `${action} remains available`);
  assert.deepEqual(calls.pop(), [action]);
}
assert.deepEqual(readiness, ["selected"], "Codex actions refresh selected task runtime, including OpenAI tasks with Codex text/voice");
local = false;
assert.equal((await codex.POST(req({ action: "sign-in" }))).status, 403);
assert.equal((await mac.POST(req({ id: "approval", decision: "always" }))).status, 403);
local = true;
ready = false;
assert.equal((await mac.POST(req({ id: "approval", decision: "once" }))).status, 409);
assert.equal((await codex.POST(req({ action: "sign-in" }))).status, 409);
ready = true;
assert.equal((await mac.PATCH(req({ fullAccess: true }))).status, 403, "a bot cannot enable Full access");
window = true;
assert.equal((await mac.PATCH(req({ fullAccess: true }))).status, 200);
assert.deepEqual(calls.pop(), ["fullAccess", true]);
await mac.PATCH(req({ removeApp: "Calculator" }));
assert.deepEqual(state.mac.alwaysApps, []);
assert.deepEqual(calls, [], "refused actions have no effects");
console.log("codex-controls: approvals, sign-in, local/state guards and Full access passed");
