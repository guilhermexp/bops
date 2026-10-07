// Tests for model runtimes (lib/server/runtime) and the text capability: which runtime runs text
// (BOPS_RUNTIME, BOPS_TEXT_RUNTIME), text on the user's ChatGPT plan through the Codex backend (the
// body it accepts, a chat's tool loop sent whole, structured output, a sign-in renewed by Codex and
// never written by Bops, the plan's usage limit said with when it's back, no sign-in shown as the way
// in), text on OpenAI as before, and Codex starting on the user's own Codex setup (lib/server/codex.ts).
// The Codex backend and OpenAI are fakes on localhost, Codex's home a temporary folder, the state a
// throwaway file store, and every address outside this machine is closed to the processes Codex
// starts: nothing reaches the network.
// Usage: node --conditions=react-server scripts/test-runtime-text.mjs [section]
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of ["BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "HONCHO_API_KEY", "COMPOSIO_API_KEY", "TYPESAFE_API_KEY", "ORGO_API_KEY", "OPENAI_API_KEY", "BOPS_RUNTIME", "BOPS_TEXT_RUNTIME", "BOPS_TASK_RUNTIME", "BOPS_VOICE_RUNTIME", "BOPS_CHAT_MODEL", "BOPS_SAM_MODEL", "BOPS_PHONE_MODEL", "AGENTPHONE_API_KEY"])
  delete process.env[k];
const scratch = mkdtempSync(join(tmpdir(), "bops-test-runtime-text-"));
const codexHome = join(scratch, "codex-home");
mkdirSync(codexHome, { recursive: true });
Object.assign(process.env, {
  BOPS_SELF_HOSTED: "1",
  CODEX_HOME: codexHome,
  // Codex itself (the app server Bops starts) can't reach anything but this machine.
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
});
const only = process.argv[2];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded (the relay's agent) or that Node can't load (the
// desktop look draws the mascot's JSX, mirror.ts has parameter properties) are stand-ins: each of their
// exports does nothing (as scripts/test-plan.mjs). Codex's is real where its CLI is installed (Codex
// starting is under test); elsewhere its `codex` is an empty object the renewal test fills in.
const STAND_INS = new Set(["relay", "desktop", "mirror"]);
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => (n === "codex" ? "export const codex = {};" : `export const ${n} = function () { return Promise.resolve(); };`)).join("\n") };
  },
});
const { findCodex } = await import(`${root}/lib/server/codex-cli.ts`);
const haveCodex = !!findCodex();
if (!haveCodex) STAND_INS.add("codex");
process.chdir(scratch);
// Signed out of Orgo, and the Keychain is never asked (lib/server/orgo-auth.ts).
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;
// Nothing in this process leaves this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error(`not a fake: ${url}`);
  return realFetch(input, init);
};

const section = (name) => !only || only === name;

/* ---------------- Codex starts on the user's own setup ---------------- */

if (section("codex-config")) {
  if (!haveCodex) console.log("codex-config: no Codex CLI on this machine, skipped");
  else {
    // A Codex setup with none of the servers and plugins Bops turns off for its threads (cua-driver,
    // cua, Composio): Codex starts anyway, and the next step is signing in (there's no auth.json here).
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n\n[mcp_servers.node_repl]\ncommand = "true"\n');
    const S = await import(`${root}/lib/server/store.ts`);
    const C = await import(`${root}/lib/server/codex.ts`);
    await C.checkMac();
    const mac = S.getState().mac;
    assert.ok(mac, "the Mac was checked");
    assert.doesNotMatch(mac.reason ?? "", /Codex didn't start/, `Codex starts without servers it doesn't have (${mac.reason})`);
    assert.equal(mac.next, "sign-in", "Codex answered: not signed in yet");
    console.log("codex-config -> Codex started, next step:", mac.next);
  }
}

if (only && only !== "text") {
  console.log(`all runtime tests passed (${only})`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

/* ---------------- Fakes: the Codex backend, OpenAI, Codex's renewal ---------------- */

/** A JWT like Codex's access token (unsigned: Bops only reads its claims). */
const jwt = (claims) => ["{}", JSON.stringify(claims), "sig"].map((p) => Buffer.from(p).toString("base64url")).join(".");
const authPath = join(codexHome, "auth.json");
let tokenNo = 0;
/** A new sign-in in auth.json, written as Codex writes it (a new file in place of the old one). Bops never writes it: the file is read-only. */
function signIn({ expiresIn = 3600, plan = "pro" } = {}) {
  const token = jwt({ exp: Math.floor(Date.now() / 1000) + expiresIn, "https://api.openai.com/auth": { chatgpt_account_id: "acct_test", chatgpt_plan_type: plan }, n: ++tokenNo });
  const tmp = `${authPath}.new`;
  writeFileSync(tmp, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: token, refresh_token: "rt-test", account_id: "acct_test" }, last_refresh: new Date().toISOString() }));
  chmodSync(tmp, 0o444);
  renameSync(tmp, authPath);
  return token;
}

/** Every request to the fake Codex backend, and what it answers next. */
const codexAsked = [];
let codexAnswer = () => ({ text: "Hi from your plan." });
/** Tokens the fake backend turns down (401), as if they'd expired. */
const revoked = new Set();
/** Every request to the fake OpenAI, and what it answers next. */
const openaiAsked = [];
let openaiAnswer = () => ({ text: "Hi from OpenAI." });

const itemsOf = (r) => [
  ...(r.reasoning ? [{ id: "rs_1", type: "reasoning", summary: [], encrypted_content: r.reasoning }] : []),
  ...(r.tools ?? []).map((t, i) => ({ id: `fc_${codexAsked.length}_${i}`, type: "function_call", status: "completed", call_id: `call_${codexAsked.length}_${i}`, name: t.name, arguments: JSON.stringify(t.args) })),
  ...(r.text ? [{ id: `msg_${codexAsked.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text, annotations: [] }] }] : []),
];
const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.method === "POST" && req.url === "/codex/responses") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    codexAsked.push({ headers: req.headers, body, token });
    if (revoked.has(token)) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "token expired" } }));
    const r = codexAnswer(body);
    if (r.status) return void res.writeHead(r.status, { "content-type": "application/json", ...r.headers }).end(JSON.stringify(r.json ?? {}));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { id: "resp_c" } },
      ...itemsOf(r).map((item) => ({ type: "response.output_item.done", item })),
      { type: "response.completed", response: { id: `resp_${codexAsked.length}`, model: body.model, usage: { input_tokens: 30, output_tokens: 7 } } },
    ];
    // In pieces, the way a stream arrives.
    for (const e of events) {
      const s = `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`;
      res.write(s.slice(0, 20));
      await new Promise((d) => setTimeout(d, 2));
      res.write(s.slice(20));
    }
    return void res.end();
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    openaiAsked.push({ body });
    const r = openaiAnswer(body);
    const output = itemsOf(r).filter((i) => i.type !== "reasoning");
    return void res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ id: `resp_o${openaiAsked.length}`, object: "response", model: "gpt-test", status: "completed", output, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }),
    );
  }
  res.writeHead(404).end("{}");
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;
process.env.BOPS_CODEX_BASE_URL = `${base}/codex`;
process.env.OPENAI_BASE_URL = `${base}/v1`;

const S = await import(`${root}/lib/server/store.ts`);
const C = await import(`${root}/lib/server/codex.ts`);
const config = await import(`${root}/lib/server/runtime/config.ts`);
const text = await import(`${root}/lib/server/runtime/text/index.ts`);
const chat = await import(`${root}/lib/server/chat.ts`);
const sessions = await import(`${root}/lib/server/sessions.ts`);

// Codex's renewal (account/read with refreshToken): Codex writes the new sign-in, as it does for real.
const renewals = [];
let renewal = () => ({ account: { type: "chatgpt", planType: "pro" } });
C.codex.ready = async () => {};
C.codex.request = async (method, params) => {
  if (method !== "account/read") return {};
  renewals.push(params);
  const r = renewal();
  if (params?.refreshToken && r.account) signIn();
  return r;
};

S.update((s) => (s.owner = { name: "Alex", about: "" }));
const main = S.getState().bots.find((b) => b.isMain);
assert.ok(main, "a fresh state has a main bot");
const chatId = `bot:${main.id}`;
const lastBot = () => S.getState().messages.filter((m) => m.chatId === chatId && m.role === "bot").at(-1)?.text;
const send = async (words) => {
  await chat.handleMessage(chatId, words);
  return lastBot();
};
const tokensOf = (source) => (S.getState().usage ?? []).filter((u) => u.kind === "model.tokens" && u.source === source);

/* ---------------- Which runtime runs text ---------------- */

{
  assert.equal(config.runtimeFor("text"), "openai", "OpenAI unless told otherwise, as upstream");
  process.env.BOPS_RUNTIME = "codex";
  assert.equal(config.runtimeFor("text"), "codex");
  assert.equal(config.runtimeFor("tasks"), "codex", "BOPS_RUNTIME is every capability's");
  process.env.BOPS_TEXT_RUNTIME = "openai";
  assert.equal(config.runtimeFor("text"), "openai", "BOPS_TEXT_RUNTIME wins for text");
  assert.equal(config.runtimeFor("tasks"), "codex", "and only for text");
  process.env.BOPS_TEXT_RUNTIME = "anthropic";
  assert.throws(() => config.runtimeFor("text"), { message: 'Unknown runtime "anthropic" in BOPS_TEXT_RUNTIME. Use openai or codex.' });
  delete process.env.BOPS_TEXT_RUNTIME;
  process.env.BOPS_RUNTIME = "gemini";
  const before = codexAsked.length + openaiAsked.length;
  await assert.rejects(text.generateText({ role: "chat", effort: "low", instructions: "x", input: "x", usage: { source: "chat" } }), { message: 'Unknown runtime "gemini" in BOPS_RUNTIME. Use openai or codex.' });
  assert.equal(codexAsked.length + openaiAsked.length, before, "an unknown runtime asks no one");
  process.env.BOPS_RUNTIME = "codex";
  console.log("selection -> openai by default, per capability over BOPS_RUNTIME, unknown ids refused");
}

/* ---------------- Text on the ChatGPT plan: what the Codex backend gets ---------------- */

signIn();
{
  codexAnswer = () => ({ text: "Hi Alex, it's your plan talking.", reasoning: "enc-a" });
  assert.equal(await send("Hi there"), "Hi Alex, it's your plan talking.");
  const { headers, body, token } = codexAsked.at(-1);
  assert.equal(token, JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token, "the sign-in in auth.json");
  assert.equal(headers["chatgpt-account-id"], "acct_test");
  assert.equal(headers.originator, "bops");
  assert.match(headers["user-agent"], /^bops \(/, "Bops says it's Bops");
  assert.doesNotMatch(`${headers["user-agent"]} ${headers.originator}`, /Codex Desktop/);
  assert.equal(headers["openai-beta"], "responses=experimental");
  assert.ok(headers.session_id, "a session id");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  for (const k of ["previous_response_id", "max_output_tokens", "temperature", "top_p"]) assert.ok(!(k in body), `no ${k}: the backend turns it down`);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.ok(body.tools.some((t) => t.name === "schedule"), "the chat's tools");
  assert.deepEqual(body.input.at(-1), { role: "user", content: "Hi there" });
  assert.equal(openaiAsked.length, 0, "nothing to OpenAI");
  assert.equal(tokensOf("chat").at(-1).inputTokens, 30, "tokens counted as before");
  console.log("codex body -> store:false, stream:true, no previous_response_id or max_output_tokens");
}

/* ---------------- A chat's tool loop, sent whole ---------------- */

{
  const from = codexAsked.length;
  codexAnswer = (body) =>
    body.input.some((i) => i.type === "function_call_output")
      ? { text: "Nothing's being watched, so there was nothing to stop. And I set the reminder." }
      : { reasoning: "enc-loop", tools: [{ name: "stop_watch", args: { watch_id: "w_nope" } }, { name: "schedule", args: { title: "Drink water", goal: "Remind Alex to drink water", schedule: { kind: "once", time: null, day: null, at: new Date(Date.now() + 120_000).toISOString() }, reminder: "Time to drink some water.", where: "auto", by_text: false } }] };
  assert.equal(await send("Stop watching that and remind me in 2 minutes to drink water"), "Nothing's being watched, so there was nothing to stop. And I set the reminder.");
  const [first, second] = codexAsked.slice(from).map((a) => a.body);
  assert.equal(codexAsked.length - from, 2, "one lookup round");
  assert.ok(!("previous_response_id" in second));
  // The whole conversation again: what was asked, then what came back (reasoning as it was, without ids), then the outputs.
  assert.deepEqual(second.input.slice(0, first.input.length), first.input);
  const [reasoning, stop, schedule, out1, out2] = second.input.slice(first.input.length);
  assert.deepEqual(reasoning, { type: "reasoning", summary: [], encrypted_content: "enc-loop" });
  assert.equal(stop.type, "function_call");
  assert.equal(stop.name, "stop_watch");
  assert.ok(!("id" in stop), "items are sent without their ids");
  assert.equal(schedule.name, "schedule");
  assert.deepEqual(out1, { type: "function_call_output", call_id: stop.call_id, output: "No such watch." });
  assert.deepEqual(out2, { type: "function_call_output", call_id: schedule.call_id, output: "ok" });
  assert.equal(second.instructions, first.instructions);
  assert.deepEqual(second.tools, first.tools);
  const routine = S.getState().routines.find((r) => r.title === "Drink water");
  assert.ok(routine, "the routine from the first round's call is made");
  assert.equal(routine.reminder, "Time to drink some water.");
  assert.ok(S.getState().messages.some((m) => m.chatId === chatId && m.role === "system" && m.text.startsWith('Scheduled "Drink water"')));
  console.log("tool loop -> history + reasoning + outputs sent again, routine saved");
}

/* ---------------- Structured output ---------------- */

{
  codexAnswer = () => ({ text: JSON.stringify({ replies: ["The 9am one.", "The 2pm one", "stop"] }) });
  S.update((s) => s.sessions.push({ id: "ses_q", botId: main.id, chatId, title: "Flights", goal: "Book a flight to Denver", status: "done", replies: [], answer: "Should I book the 9am or the 2pm flight?", createdAt: Date.now() }));
  await sessions.suggestFor("ses_q");
  const { body } = codexAsked.at(-1);
  assert.deepEqual(body.text, { format: { type: "json_schema", name: "replies", strict: true, schema: { type: "object", additionalProperties: false, required: ["replies"], properties: { replies: { type: "array", items: { type: "string" } } } } } });
  assert.deepEqual(S.getState().sessions.find((s) => s.id === "ses_q").options, ["The 9am one", "The 2pm one"], "parsed and tidied as before");
  assert.ok(tokensOf("session").length, "counted as a session's");
  console.log("structured output -> json_schema, replies:", S.getState().sessions.find((s) => s.id === "ses_q").options.join(" | "));
}

/* ---------------- A sign-in that ran out: Codex renews it, Bops never writes auth.json ---------------- */

{
  const old = JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token;
  const mode = statSync(authPath).mode & 0o777;
  revoked.add(old);
  codexAnswer = () => ({ text: "Still here." });
  const from = codexAsked.length;
  assert.equal(await send("You there?"), "Still here.");
  const tried = codexAsked.slice(from);
  assert.equal(tried.length, 2, "turned down once, then asked again");
  assert.equal(tried[0].token, old);
  const renewed = JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token;
  assert.notEqual(renewed, old);
  assert.equal(tried[1].token, renewed, "with the sign-in Codex renewed");
  assert.deepEqual(renewals.at(-1), { refreshToken: true }, "Codex was asked to renew it");
  assert.equal(statSync(authPath).mode & 0o777, mode, "auth.json is still Codex's read-only file");
  // An expired token is renewed before the call.
  signIn({ expiresIn: -10 });
  const n = renewals.length;
  await send("And now?");
  assert.equal(renewals.length, n + 1);
  assert.equal(codexAsked.at(-1).token, JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token);
  console.log("renewal -> 401, Codex renewed the sign-in, asked again; auth.json untouched by Bops");
}

/* ---------------- Not signed in: the way in, not an OpenAI key error ---------------- */

{
  // Codex can't renew it (signed out): the bot says where to sign in.
  revoked.add(JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token);
  renewal = () => ({ account: null });
  const said = await send("Hello?");
  assert.match(said, /^Codex isn't signed in with your ChatGPT account\. Sign in from Settings → This Mac/);
  assert.doesNotMatch(said, /OPENAI_API_KEY|OpenAI key/);
  // No auth.json at all: the same, without asking the backend.
  rmSync(authPath);
  const from = codexAsked.length;
  assert.match(await send("Hello??"), /^Codex isn't signed in with your ChatGPT account/);
  assert.equal(codexAsked.length, from);
  renewal = () => ({ account: { type: "chatgpt", planType: "pro" } });
  signIn();
  console.log("sign-in ->", said);
}

/* ---------------- The plan's usage limit ---------------- */

{
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  const time = new Date(resetsAt * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  codexAnswer = () => ({ status: 429, json: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "pro", resets_at: resetsAt } } });
  const said = await send("Plan my week");
  const sameDay = new Date(resetsAt * 1000).toDateString() === new Date().toDateString();
  assert.ok(said.startsWith("I've hit the usage limit on your ChatGPT Pro plan, so I've stopped. It's back "), said);
  assert.ok(said.endsWith(sameDay ? `at ${time}.` : ` at ${time}.`), said);
  assert.equal(S.getState().credits, undefined, "not Bops Cloud's credit (no Upgrade)");
  // Until it resets, nothing more is asked, and the bot says so again.
  const from = codexAsked.length;
  assert.equal(await send("Hello?"), said);
  assert.equal(codexAsked.length, from);
  // Said by the headers instead (the 5-hour window used up).
  globalThis.bopsCodexLimit = undefined;
  const at = Math.floor(Date.now() / 1000) + 600;
  codexAnswer = () => ({ status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(at), "x-codex-secondary-used-percent": "40", "x-codex-secondary-reset-at": String(at + 86400) }, json: {} });
  assert.ok((await send("Again")).includes(new Date(at * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })), "the reset of the window that's used up");
  globalThis.bopsCodexLimit = undefined;
  console.log("limit ->", said);
}

/* ---------------- Text on OpenAI, as before ---------------- */

{
  process.env.BOPS_TEXT_RUNTIME = "openai";
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  const from = codexAsked.length;
  openaiAnswer = (body) => (body.previous_response_id ? { text: "Done, from OpenAI." } : { tools: [{ name: "stop_watch", args: { watch_id: "w_nope" } }] });
  assert.equal(await send("Stop watching it"), "Done, from OpenAI.");
  const [first, second] = openaiAsked.slice(-2).map((a) => a.body);
  assert.equal(first.model, "gpt-6.1-sol");
  assert.deepEqual(first.reasoning, { effort: "low" });
  assert.ok(!("store" in first) && !("stream" in first) && !("include" in first), "OpenAI's own defaults, as upstream");
  assert.equal(second.previous_response_id, "resp_o" + (openaiAsked.length - 1), "continued from the last response, not sent whole");
  assert.deepEqual(second.input, [{ type: "function_call_output", call_id: `call_${codexAsked.length}_0`, output: "No such watch." }]);
  assert.equal(codexAsked.length, from, "nothing to the Codex backend");
  delete process.env.OPENAI_API_KEY;
  console.log("openai -> previous_response_id tool loop, nothing to Codex");
}

console.log(`all runtime tests passed (${codexAsked.length} fake Codex calls, ${openaiAsked.length} fake OpenAI calls, none to the network)`);
fake.close();
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
