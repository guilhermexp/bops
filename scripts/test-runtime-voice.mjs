// Voice behind a runtime (lib/server/runtime/voice): a call in the app on the user's ChatGPT plan
// (codex/realtime/calls, gpt-live-1-codex, sideband on the server) and the same call on OpenAI's API
// (gpt-live-1, the page's data channel) as before. The Codex backend, its sideband and OpenAI are
// fakes on localhost; Codex's home and the app state are throwaway. Nothing reaches the network.
// Usage: node --conditions=react-server scripts/test-runtime-voice.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { mock } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

for (const k of ["BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "HONCHO_API_KEY", "COMPOSIO_API_KEY", "TYPESAFE_API_KEY", "ORGO_API_KEY", "OPENAI_API_KEY", "OPENAI_WEBHOOK_SECRET", "BOPS_RUNTIME", "BOPS_TEXT_RUNTIME", "BOPS_TASK_RUNTIME", "BOPS_VOICE_RUNTIME", "BOPS_CHAT_MODEL", "BOPS_SAM_MODEL", "BOPS_PHONE_MODEL", "AGENTPHONE_API_KEY", "BOPS_CODEX_CLIENT_VERSION", "BOPS_VOICE_SIDEBAND_BASE"])
  delete process.env[k];

const scratch = mkdtempSync(join(tmpdir(), "bops-test-runtime-voice-"));
const codexHome = join(scratch, "codex-home");
mkdirSync(codexHome, { recursive: true });
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAND_INS = new Set(["codex", "relay", "desktop", "mirror"]);
let fixtureVoiceInput;
globalThis.__bopsFixtureVoice = {
  chooseVoice: async () => "fixture-voice",
  answer: async (input) => {
    fixtureVoiceInput = input;
    return { sdp: "fixture-answer", sessionId: "fixture-session", client: { transport: "server", callId: "fixture-call" } };
  },
  say: async () => {},
  close: async () => {},
  events: () => null,
};
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
    if (url.endsWith("/runtime/config.ts")) {
      const source = readFileSync(new URL(url), "utf8").replace('["openai", "codex"] as const', '["openai", "codex", "fixture"] as const');
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    if (url.endsWith("/runtime/voice/index.ts")) {
      const original = readFileSync(new URL(url), "utf8");
      const source = original.replace("codex: codexVoiceRuntime };", "codex: codexVoiceRuntime, fixture: globalThis.__bopsFixtureVoice };");
      if (source === original) throw new Error("The test could not register its fixture voice runtime.");
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => (n === "codex" ? "export const codex = {};" : `export const ${n} = function () { return Promise.resolve(); };`)).join("\n") };
  },
});

const OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const ANSWER = "v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const OA_ANSWER = "v=0\r\no=- 3 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
// Stable voice groups are inherited local configuration, not provider gender metadata.
const MALE = ["arbor", "cove", "ember", "spruce"];
const FEMALE = ["breeze", "juniper", "maple", "sol", "vale"];
const pick = (id, gender) => {
  const list = gender === "female" ? FEMALE : MALE;
  return list[[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % list.length];
};

const jwt = (claims) => ["{}", JSON.stringify(claims), "sig"].map((p) => Buffer.from(p).toString("base64url")).join(".");
const authPath = join(codexHome, "auth.json");
let tokenNo = 0;
function signIn({ expiresIn = 3600, plan = "pro" } = {}) {
  const token = jwt({ exp: Math.floor(Date.now() / 1000) + expiresIn, "https://api.openai.com/auth": { chatgpt_account_id: "acct_test", chatgpt_plan_type: plan }, n: ++tokenNo });
  const tmp = `${authPath}.new`;
  writeFileSync(tmp, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: token, refresh_token: "rt-test", account_id: "acct_test" }, last_refresh: new Date().toISOString() }));
  chmodSync(tmp, 0o444);
  renameSync(tmp, authPath);
  return token;
}

const signaling = [];
const livePosts = [];
const sidebandSockets = [];
const sidebandGot = [];
let signalingAnswer = () => ({ status: 201, sdp: ANSWER, callId: `rtc_${signaling.length}` });
let liveAnswer = () => ({ session: { id: "sess_oa" }, transport: { type: "webrtc", sdp: OA_ANSWER } });

const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/codex/realtime/calls") {
    const body = JSON.parse(raw || "{}");
    signaling.push({ url: req.url, headers: req.headers, body, token: (req.headers.authorization ?? "").replace(/^Bearer /, "") });
    const r = signalingAnswer();
    if (r.status !== 201) return void res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) }).end(JSON.stringify(r.json ?? {}));
    return void res.writeHead(201, { "content-type": "application/sdp", location: `/codex/realtime/calls/${r.callId}` }).end(r.sdp);
  }
  if (req.method === "POST" && url.pathname === "/codex/responses") {
    const body = JSON.parse(raw);
    const output = body.input.some((i) => i.type === "function_call_output")
      ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll remind you to stretch in two minutes." }] }
      : { type: "function_call", call_id: "schedule_voice", name: "schedule", arguments: JSON.stringify({ title: "Stretch", goal: "Remind the user to stretch", schedule: { kind: "once", time: null, day: null, at: new Date(Date.now() + 120_000).toISOString() }, reminder: "Time to stretch.", where: "auto", by_text: false }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.output_item.done", item: output }, { type: "response.completed", response: { model: body.model, usage: { input_tokens: 20, output_tokens: 8 } } }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    return void res.end();
  }
  if (req.method === "POST" && url.pathname === "/v1/live/sessions") {
    livePosts.push({ body: JSON.parse(raw || "{}"), headers: req.headers });
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(liveAnswer()));
  }
  res.writeHead(404).end("{}");
});
const wss = new WebSocketServer({ noServer: true });
fake.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    sidebandSockets.push({ url: req.url, headers: req.headers, ws });
    ws.on("message", (data) => sidebandGot.push(JSON.parse(String(data))));
    wss.emit("connection", ws, req);
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const port = fake.address().port;
const base = `http://127.0.0.1:${port}`;

Object.assign(process.env, {
  BOPS_SELF_HOSTED: "1",
  CODEX_HOME: codexHome,
  BOPS_RUNTIME: "codex",
  BOPS_CODEX_BASE_URL: `${base}/codex`,
  BOPS_VOICE_SIDEBAND_BASE: `ws://127.0.0.1:${port}/v1/live`,
  BOPS_CODEX_CLIENT_VERSION: "9.9.9",
  OPENAI_BASE_URL: `${base}/v1`,
  OPENAI_API_KEY: "",
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
});
process.chdir(scratch);
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`not a fake: ${url.hostname}`);
  return realFetch(input, init);
};

const realTimeout = globalThis.setTimeout;
const until = async (pred, label, failure = () => assert.fail(label)) => {
  for (let i = 0; i < 100; i++) {
    if (await pred()) return;
    await new Promise((r) => realTimeout(r, 20));
  }
  failure();
};

const S = await import(`${root}/lib/server/store.ts`);
const C = await import(`${root}/lib/server/codex.ts`);
const callRoute = await import(`${root}/app/api/call/route.ts`);
const sipRoute = await import(`${root}/app/api/phone/openai/route.ts`);
const renewals = [];
C.codex.ready = async () => {};
C.codex.request = async (method, params) => {
  if (method !== "account/read") return {};
  renewals.push(params);
  await new Promise((d) => setTimeout(d, 10));
  if (params?.refreshToken) signIn();
  return { account: { type: "chatgpt", planType: "pro" } };
};

S.update((s) => {
  s.owner = { name: "Alex", about: "" };
  s.bots.push({ id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none" });
});
const boppy = S.getState().bots.find((b) => b.isMain);
assert.equal(boppy.name, "Boppy");
const token = signIn();

{
  process.env.BOPS_VOICE_RUNTIME = "fixture";
  const voice = await import(`${root}/lib/server/runtime/voice/index.ts`);
  await voice.answerVoice(boppy, OFFER, "fixture test");
  assert.equal(fixtureVoiceInput.voice, "fixture-voice", "the selected runtime chooses the voice it sends to its provider");
  delete process.env.BOPS_VOICE_RUNTIME;
  console.log("fixture voice -> answer uses the runtime's own voice choice");
}

const post = (body) => callRoute.POST(new Request("http://127.0.0.1/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const eventsOf = async (callId, after) => {
  const res = await callRoute.GET(new Request(`http://127.0.0.1/api/call?callId=${callId}&after=${after}`));
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

// Exercise the public runtime against a real localhost WebSocket, with virtual idle time.
async function lifecycle(which) {
  const { codexVoiceRuntime: runtime } = await import(`${root}/lib/server/runtime/voice/codex.ts`);
  delete process.env.BOPS_VOICE_RUNTIME;
  signalingAnswer = () => ({ status: 201, sdp: ANSWER, callId: `rtc_${signaling.length}` });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const res = await post({ action: "start", botId: boppy.id, sdp: OFFER });
    const json = await res.json();
    assert.equal(res.status, 201, json.error ?? "");
    const callId = json.client.callId;
    const band = sidebandSockets.at(-1);
    if (which === "session-closed") {
      // The provider closes the session, deliberately leaving its WebSocket open.
      band.ws.send(JSON.stringify({ type: "session.closed" }));
      await until(() => runtime.events(callId, 0)?.events.some((e) => e.kind === "closed"), "provider close reaches polling");
      await until(() => band.ws.readyState === 3, "session.closed must close the still-open sideband socket", () => assert.equal(band.ws.readyState, 3, "session.closed must close the still-open sideband socket"));
      assert.equal((await post({ action: "close", callId })).status, 200, "browser cleanup after provider close is idempotent");
      assert.equal(runtime.events(callId, 0).events.filter((e) => e.kind === "closed").length, 1);
      console.log("lifecycle session.closed -> sideband closed, browser cleanup idempotent");
    } else {
      const hour = 60 * 60_000;
      mock.timers.tick(hour - 1);
      assert.ok(runtime.events(callId, 0), "successful polling keeps the call active");
      mock.timers.tick(2);
      await new Promise((r) => realTimeout(r, 30));
      assert.equal(band.ws.readyState, 1, "active polling call must survive its original one-hour deadline");
      await runtime.say(callId, "Still here.");
      await until(() => sidebandGot.some((e) => e.content?.[0]?.text === "Still here."), "successful control reaches the sideband");
      mock.timers.tick(hour - 1);
      await new Promise((r) => realTimeout(r, 30));
      assert.equal(band.ws.readyState, 1, "successful control must renew the inactivity deadline too");
      mock.timers.tick(1);
      await until(() => band.ws.readyState === 3, "one hour without polling or control closes the abandoned sideband");
      assert.ok(runtime.events(callId, 0).events.some((e) => e.kind === "closed"));
      await assert.rejects(runtime.say(callId, "Too late."), /This voice call has ended/);
      console.log("lifecycle idle -> polling and control renew; abandoned call expires after one idle hour");
    }
    // Polling a terminal record cannot prolong its retention or rearm an idle timer.
    mock.timers.tick(60_000);
    assert.equal(runtime.events(callId, 0), null, "closed call is removed after the caption buffer expires");
  } finally {
    mock.timers.reset();
  }
}

const focusedLifecycle = process.argv[2];
if (focusedLifecycle) {
  assert.ok(["session-closed", "idle"].includes(focusedLifecycle));
  await lifecycle(focusedLifecycle);
  fake.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

/* ---------------- A call on the plan: SDP in, SDP out, the token stays on the server ---------------- */

{
  const beforeLive = livePosts.length;
  const res = await post({ action: "start", botId: boppy.id, sdp: OFFER });
  const json = await res.json();
  assert.equal(res.status, 201, json.error ?? "");
  assert.equal(json.transport.sdp, ANSWER, "the browser gets the SDP answer");
  assert.equal(json.session.id, "rtc_1");
  assert.deepEqual(json.client, { transport: "server", callId: "rtc_1" });
  assert.equal(JSON.stringify(json).includes(token), false, "the answer to the page has no token");
  assert.equal(livePosts.length, beforeLive, "nothing to OpenAI's live API");
  const asked = signaling.at(-1);
  assert.equal(asked.url, "/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.equal(asked.token, token);
  assert.equal(asked.headers["chatgpt-account-id"], "acct_test");
  assert.equal(asked.headers["openai-alpha"], "quicksilver=v2");
  assert.equal(asked.headers.originator, "Codex Desktop");
  assert.equal(asked.headers["user-agent"], "Codex Desktop/9.9.9");
  assert.equal(asked.headers.version, "9.9.9");
  assert.ok(asked.headers["x-session-id"]);
  assert.ok(asked.headers["session-id"]);
  assert.ok(asked.headers["thread-id"]);
  assert.equal(asked.body.sdp, OFFER);
  assert.equal(asked.body.session.model, "gpt-live-1-codex");
  assert.equal(asked.body.session.audio.output.voice, "cove", "Boppy's voice on the plan");
  assert.deepEqual(asked.body.session.delegation, { type: "client" });
  assert.match(asked.body.session.instructions, /You are Boppy/);
  assert.match(asked.body.session.instructions, /Hello\? Can you hear me\?/);
  await until(() => sidebandSockets.length === 1, "the server opens the sideband");
  const band = sidebandSockets[0];
  assert.equal(band.url, "/v1/live/rtc_1");
  assert.equal(band.headers.authorization, `Bearer ${token}`, "the sideband authenticates; the page never does");
  band.ws.send(JSON.stringify({ type: "session.started", session: { id: "sess_live" } }));
  await until(async () => {
    const got = await eventsOf("rtc_1", 0);
    return got.events.some((e) => e.kind === "started") ? got : null;
  }, "session.started reaches the page");
  const started = await eventsOf("rtc_1", 0);
  assert.deepEqual(started.events[0], { kind: "started" });
  console.log("codex call -> SDP round trip, sideband open, token not in the page's answer");
}

/* ---------------- Otto's voice is a man's, and the same one every time ---------------- */

{
  const res = await post({ action: "start", botId: "otto", sdp: OFFER });
  const json = await res.json();
  assert.equal(res.status, 201, json.error ?? "");
  assert.equal(signaling.at(-1).body.session.audio.output.voice, pick("otto", "male"));
  assert.notEqual(pick("otto", "male"), pick("otto", "female"));
  const again = await post({ action: "start", botId: "otto", sdp: OFFER });
  assert.equal(again.status, 201);
  assert.equal(signaling.at(-1).body.session.audio.output.voice, pick("otto", "male"), "the same voice on the next call");
  const voices = await import(`${root}/lib/server/runtime/voice/voices.ts`);
  assert.deepEqual([...voices.CODEX_MALE], MALE);
  assert.deepEqual([...voices.CODEX_FEMALE], FEMALE);
  console.log("voices -> Boppy cove; Otto", pick("otto", "male"));
}

/* ---------------- What the bot is told comes back in chunks of at most 500 bytes, then the session closes ---------------- */

{
  const callId = "rtc_1";
  const text = `${"a".repeat(499)}é${"b".repeat(100)}😀${"c".repeat(400)}`;
  assert.ok(Buffer.byteLength(text) > 500);
  const from = sidebandGot.length;
  const said = await post({ action: "speak", callId, content: text, delegationId: "del_1" });
  assert.equal(said.status, 200, await said.clone().text());
  await until(() => sidebandGot.length > from, "the sideband receives the delegation");
  const frames = sidebandGot.slice(from).filter((m) => m.type === "delegation.context.append");
  assert.ok(frames.length >= 2, "a long result is more than one chunk");
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(frame.content[0].text) <= 500, "each chunk is at most 500 UTF-8 bytes");
    assert.equal(frame.delegation_item_id, "del_1");
    assert.equal(frame.channel, "commentary");
    assert.equal(frame.content[0].type, "input_text");
  }
  assert.equal(frames.map((f) => f.content[0].text).join(""), text, "the chunks are the whole result, and no character is split");
  const greetFrom = sidebandGot.length;
  const greet = await post({ action: "speak", callId, content: 'You just picked up the call. Say only: "Hello? Can you hear me?"' });
  assert.equal(greet.status, 200);
  await until(() => sidebandGot.length > greetFrom, "the greeting goes out");
  const greeting = sidebandGot.at(-1);
  assert.equal(greeting.type, "session.context.append");
  assert.equal(greeting.channel, "commentary");
  assert.equal("delegation_item_id" in greeting, false);
  sidebandSockets[0].ws.send(JSON.stringify({ type: "input_transcript.added", item: { text: "hello" } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "input_transcript.added", item: { text: "hello there" } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "output_transcript.added", item: { text: "Four." } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "delegation.created", item: { type: "delegation", target: "client", id: "del_9", content: [{ type: "input_text", text: "remind me to stretch" }] } }));
  let relayed;
  await until(async () => {
    relayed = await eventsOf(callId, 0);
    return relayed.events.some((e) => e.kind === "delegation") ? relayed : null;
  }, "captions and the delegation reach the page");
  const input = relayed.events.filter((e) => e.kind === "input").map((e) => e.delta).join("");
  assert.equal(input, "hello there");
  assert.equal(relayed.events.filter((e) => e.kind === "output").map((e) => e.delta).join(""), "Four.");
  const delegation = relayed.events.find((e) => e.kind === "delegation");
  assert.equal(delegation.id, "del_9");
  assert.equal(delegation.request, "remind me to stretch");
  const delegated = await post({ action: "delegate", botId: boppy.id, request: delegation.request });
  assert.equal(delegated.status, 200);
  const result = await delegated.json();
  assert.match(result.result, /stretch/i, "voice receives the chat result describing the persisted reminder");
  assert.ok(S.getState().routines.some((r) => r.title === "Stretch" && r.reminder === "Time to stretch."), "delegate runs through chat and persists the reminder");
  const deliveredFrom = sidebandGot.length;
  await post({ action: "speak", callId, content: result.result, delegationId: "del_9", complete: true });
  await until(() => sidebandGot.length > deliveredFrom, "the final delegation result goes back to voice");
  assert.equal(sidebandGot.at(-1).channel, undefined, "the final result uses Frameless Bidi's default response channel, as OMP does");
  sidebandSockets[0].ws.send(JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "hello there" } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "input_transcript.added", item: { text: "hello there" } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "input_transcript.added", item: { text: "New" } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "input_transcript.added", item: { text: " question" } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "New question" } }));
  await until(async () => (await eventsOf(callId, 0)).events.some((e) => e.kind === "input" && e.text === "New question"), "a new turn reaches captions");
  const laterInputs = (await eventsOf(callId, 0)).events.filter((e) => e.kind === "input");
  assert.equal(laterInputs.map((e) => e.delta).join(""), "hello thereNew question", "final transcript and late repeated snapshot do not duplicate text");
  sidebandSockets[0].ws.send(JSON.stringify({ type: "output_transcript.added", item: { text: "Please confirm." } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "turn.done", turn: { role: "assistant", transcript: "Please confirm." } }));
  sidebandSockets[0].ws.send(JSON.stringify({ type: "input_transcript.added", item: { text: "New question" } }));
  await until(async () => (await eventsOf(callId, 0)).events.filter((e) => e.kind === "input" && e.text === "New question").length === 2, "identical user turns separated by a bot reply are both retained");
  const closed = await post({ action: "close", callId });
  assert.equal(closed.status, 200);
  await until(() => sidebandGot.some((m) => m.type === "session.close"), "session.close on the sideband");
  const ended = await post({ action: "end", botId: boppy.id, seconds: 65, transcript: [{ who: "owner", text: "hello there" }, { who: "bot", text: "Four." }] });
  assert.equal(ended.status, 200);
  const note = S.getState().messages.find((m) => m.call && m.chatId === `bot:${boppy.id}`);
  assert.ok(note, "the call is in the chat");
  assert.equal(note.call.seconds, 65);
  assert.match(note.text, /Call ended · 1m 5s/);
  const words = S.getState().messages.find((m) => !m.call && m.text.startsWith("Call transcript"));
  assert.match(words.text, /Alex: hello there/);
  assert.match(words.text, /Boppy: Four\./);
  assert.ok(S.getState().usage.some((u) => u.kind === "call.minutes" && u.botId === boppy.id && u.qty === 1.08));
  console.log("sideband ->", frames.length, "chunks, session closed, minutes noted");
}

/* ---------------- A sign-in the backend turns down: Codex renews it, then the call goes through ---------------- */

{
  const old = token;
  const mode = statSync(authPath).mode & 0o777;
  const revoked = new Set([old]);
  signalingAnswer = () => {
    const asked = signaling.at(-1);
    if (revoked.has(asked.token)) return { status: 401, json: { error: { message: "token expired" } } };
    return { status: 201, sdp: ANSWER, callId: "rtc_renewed" };
  };
  const from = signaling.length;
  const res = await post({ action: "start", botId: boppy.id, sdp: OFFER });
  const json = await res.json();
  assert.equal(res.status, 201, json.error ?? "");
  const tried = signaling.slice(from);
  assert.equal(tried.length, 2, "turned down once, then asked again");
  assert.equal(tried[0].token, old);
  assert.notEqual(tried[1].token, old);
  assert.deepEqual(renewals.at(-1), { refreshToken: true });
  assert.equal(statSync(authPath).mode & 0o777, mode, "auth.json stays Codex's read-only file");
  assert.equal(JSON.stringify(json).includes(tried[1].token), false);
  const band = sidebandSockets.at(-1);
  const stopped = new Promise((resolve) => band.ws.once("close", resolve));
  band.ws.send(JSON.stringify({ type: "error", message: "Voice failed" }));
  await stopped;
  const failed = await eventsOf("rtc_renewed", 0);
  assert.ok(failed.events.some((e) => e.kind === "error"));
  assert.ok(failed.events.some((e) => e.kind === "closed"));
  assert.equal((await post({ action: "close", callId: "rtc_renewed" })).status, 200, "closing after a provider error is idempotent");
  console.log("renewal -> 401, then the SDP answer; provider error closes sideband");
}

/* ---------------- Not signed in: the way in, and no call to the backend ---------------- */

{
  rmSync(authPath);
  const from = signaling.length;
  const res = await post({ action: "start", botId: boppy.id, sdp: OFFER });
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.match(json.error, /^Codex isn't signed in with your ChatGPT account\. Sign in from Settings → This Mac/);
  assert.equal(signaling.length, from, "no sign-in, no request");
  assert.doesNotMatch(json.error, /OPENAI_API_KEY/);
  signIn();
  console.log("sign-in ->", json.error.slice(0, 48));
}

/* ---------------- The plan's usage limit, then no further call until it would reset ---------------- */

{
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  signalingAnswer = () => ({ status: 429, json: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: resetsAt } } });
  const res = await post({ action: "start", botId: boppy.id, sdp: OFFER });
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.match(json.error, /I've hit the usage limit on your ChatGPT Pro plan/);
  // "It's back at 9:41 PM." the same day; "It's back Thursday, Oct 8 at 12:00 AM." once the reset is past midnight.
  assert.match(json.error, /It's back (\w+day, \w+ \d+ )?at /);
  const from = signaling.length;
  const again = await post({ action: "start", botId: boppy.id, sdp: OFFER });
  const againJson = await again.json();
  assert.equal(again.status, 502);
  assert.match(againJson.error, /I've hit the usage limit/);
  assert.equal(signaling.length, from, "the limit holds: no second request");
  delete globalThis.bopsCodexLimit;
  console.log("limit ->", json.error);
}

/* ---------------- OpenAI's voice, unchanged, even when everything else is on the plan ---------------- */

{
  process.env.BOPS_VOICE_RUNTIME = "openai";
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  signalingAnswer = () => ({ status: 201, sdp: ANSWER, callId: "rtc_should_not" });
  const from = signaling.length;
  const res = await post({ action: "start", botId: boppy.id, sdp: OFFER });
  const json = await res.json();
  assert.equal(res.status, 201, json.error ?? "");
  assert.equal(signaling.length, from, "the OpenAI voice runtime does not call codex/realtime/calls");
  assert.equal(livePosts.length, 1);
  const body = livePosts[0].body;
  assert.equal(body.session.model, "gpt-live-1");
  assert.equal(body.session.audio.output.voice, "cedar");
  assert.deepEqual(body.session.delegation, { type: "client" });
  assert.equal(body.transport.type, "webrtc");
  assert.equal(body.transport.sdp, OFFER);
  assert.match(body.session.instructions, /Hello\? Can you hear me\?/);
  assert.equal(json.transport.sdp, OA_ANSWER);
  assert.equal(json.session.id, "sess_oa");
  assert.deepEqual(json.client, {
    transport: "data-channel",
    channel: "oai-events",
    started: "session.started",
    closed: "session.closed",
    input: "session.input_transcript.delta",
    output: "session.output_transcript.delta",
    delegation: "session.delegation.created",
    commentary: "session.commentary.append",
    close: "session.close",
  });
  assert.equal(JSON.stringify(json).includes(token), false);
  const { channelMessage } = await import(`${root}/lib/server/runtime/voice/channel.ts`);
  assert.deepEqual(channelMessage(json.client, { type: "session.commentary.append", delegation_id: "del_openai", content: "Reminder scheduled.", complete: true }), { type: "session.commentary.append", delegation_id: "del_openai", content: "Reminder scheduled." }, "the OpenAI commentary wire has no Codex completion hint");
  assert.deepEqual(channelMessage(json.client, { type: "session.close" }), { type: "session.close" });
  console.log("openai voice -> gpt-live-1, data channel, cedar; commentary and close unchanged");
}

/* ---------------- SIP on the plan is refused; OpenAI's voice runtime still has the webhook ---------------- */

{
  delete process.env.BOPS_VOICE_RUNTIME;
  process.env.BOPS_RUNTIME = "codex";
  const liveBefore = livePosts.length;
  const signalBefore = signaling.length;
  const refused = await sipRoute.POST(new Request("http://127.0.0.1/api/phone/openai", { method: "POST", body: "{}" }));
  const refusedJson = await refused.json();
  assert.equal(refused.status, 409);
  assert.equal(refusedJson.error, "SIP calls need the OpenAI voice runtime. Set BOPS_VOICE_RUNTIME=openai. Calls in the app use your ChatGPT plan.");
  assert.equal(livePosts.length, liveBefore);
  assert.equal(signaling.length, signalBefore);
  process.env.BOPS_VOICE_RUNTIME = "openai";
  const open = await sipRoute.POST(new Request("http://127.0.0.1/api/phone/openai", { method: "POST", body: "{}" }));
  assert.equal(open.status, 503, "without a webhook secret the OpenAI runtime still answers the route itself");
  assert.equal(livePosts.length, liveBefore, "that answer does not create a live session");
  console.log("sip -> refused on codex voice, still the OpenAI route when voice is openai");
}

await lifecycle("session-closed");
await lifecycle("idle");

console.log("all runtime voice tests passed");
fake.close();
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
