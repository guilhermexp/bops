import "server-only";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { codexAuth, CodexSignInError, type CodexAuth } from "../codex/auth";
import { codexBaseUrl, CodexLimitError } from "../codex/client";
import type { Bot } from "@/lib/types";
import { voiceOnPlan } from "./voices";
import type { VoiceEvent, VoiceRuntime, VoiceStart } from "./types";

type Call = { socket: WebSocket; events: VoiceEvent[]; base: number; input: string; output: string; closed: boolean; lastRole?: "input" | "output"; inputFinal: boolean; outputFinal: boolean; inputTurn: number; outputTurn: number; expiry?: ReturnType<typeof setTimeout> };
const g = globalThis as unknown as {
  bopsVoiceCalls?: Map<string, Call>;
  bopsCodexLimit?: { accountId: string; until: number; resetsAt?: number; plan?: string };
};
const calls = (g.bopsVoiceCalls ??= new Map<string, Call>());

function emit(call: Call, event: VoiceEvent) {
  call.events.push(event);
  if (call.events.length > 2000) { call.events.shift(); call.base++; }
}

function finish(call: Call) {
  if (call.closed) return;
  call.closed = true;
  call.socket.removeAllListeners("message");
  if (call.socket.readyState === WebSocket.OPEN) call.socket.close();
  else if (call.socket.readyState === WebSocket.CONNECTING) call.socket.terminate();
  emit(call, { kind: "closed" });
  clearTimeout(call.expiry);
  call.expiry = setTimeout(() => {
    for (const [id, value] of calls) if (value === call) calls.delete(id);
  }, 60_000);
  call.expiry.unref?.();
}

// Only inactivity expires a live call; terminal captions have a separate retention timer.
function renewIdle(call: Call) {
  if (call.closed) return;
  clearTimeout(call.expiry);
  call.expiry = setTimeout(() => {
    if (call.socket.readyState === WebSocket.OPEN) call.socket.send(JSON.stringify({ type: "session.close" }));
    finish(call);
  }, 60 * 60_000);
  call.expiry.unref?.();
}

function headers(auth: CodexAuth, session: string, realtime: string) {
  const version = process.env.BOPS_CODEX_CLIENT_VERSION?.trim() || "0.161.0";
  return {
    Authorization: `Bearer ${auth.accessToken}`, "chatgpt-account-id": auth.accountId,
    "OpenAI-Alpha": "quicksilver=v2", "User-Agent": `Codex Desktop/${version}`,
    originator: "Codex Desktop", version, "x-session-id": realtime, "session-id": session, "thread-id": session,
  };
}

type Problem = { type?: string; code?: string; message?: string; resets_at?: number; resets_in_seconds?: number };
function failure(status: number, problem: Problem, responseHeaders: Headers, auth: CodexAuth) {
  if (status === 401) return new CodexSignInError("ChatGPT didn't accept your Codex sign-in. Sign in again from Settings → This Mac (Computer use on your Mac → Sign in).");
  if (status === 429 || [problem.type, problem.code].some((v) => v === "usage_limit_reached" || v === "rate_limit_exceeded")) {
    const windows = ["primary", "secondary"].filter((w) => Number(responseHeaders.get(`x-codex-${w}-used-percent`)) >= 100)
      .map((w) => Number(responseHeaders.get(`x-codex-${w}-reset-at`)) * 1000 || Date.now() + Number(responseHeaders.get(`x-codex-${w}-reset-after-seconds`)) * 1000);
    const resetsAt = problem.resets_at ? problem.resets_at * 1000 : problem.resets_in_seconds ? Date.now() + problem.resets_in_seconds * 1000 : windows.length ? Math.max(...windows) : undefined;
    g.bopsCodexLimit = { accountId: auth.accountId, until: resetsAt ?? Date.now() + 60_000, resetsAt, plan: auth.plan };
    return new CodexLimitError(resetsAt, auth.plan);
  }
  if (problem.type === "usage_not_included") return new Error("Your ChatGPT plan doesn't include Codex, which Bops runs on. Set BOPS_RUNTIME=openai to use an OpenAI key instead.");
  // Only fixed provider text goes to the page; never echo headers or the request.
  return new Error(`ChatGPT couldn't connect the call (${status})${problem.message ? `: ${problem.message.slice(0, 300).replaceAll(auth.accessToken, "[redacted]")}` : "."}`);
}

async function signal(input: VoiceStart) {
  let auth = await codexAuth();
  const standing = g.bopsCodexLimit;
  if (standing?.accountId === auth.accountId && standing.until > Date.now()) throw new CodexLimitError(standing.resetsAt, standing.plan);
  const session = randomUUID(), realtime = randomUUID();
  const post = () => fetch(`${codexBaseUrl()}/realtime/calls?intent=quicksilver&architecture=avas`, {
    method: "POST", headers: { ...headers(auth, session, realtime), "content-type": "application/json" },
    body: JSON.stringify({ sdp: input.sdp, session: { model: "gpt-live-1-codex", instructions: input.instructions, audio: { output: { voice: input.voice } }, delegation: { type: "client" } } }),
    signal: AbortSignal.timeout(30_000),
  });
  let res = await post();
  if (res.status === 401) { await res.body?.cancel(); auth = await codexAuth(auth.accessToken); res = await post(); }
  if (!res.ok) {
    const raw = await res.text();
    let problem: Problem = {};
    try { const json = JSON.parse(raw); problem = json.error ?? { message: typeof json.detail === "string" ? json.detail : undefined }; } catch { /* HTML error pages aren't useful call captions. */ }
    throw failure(res.status, problem, res.headers, auth);
  }
  const sdp = await res.text();
  const callId = res.headers.get("location")?.split(/[/?]/).find((s) => /^rtc_[\w-]+$/.test(s));
  if (!callId || !sdp.trim()) throw new Error("ChatGPT returned no valid voice call or SDP answer.");
  return { sdp, callId, auth, session, realtime };
}

// Accept both snapshots and pieces, retaining the final turn to ignore late repeats.
function caption(call: Call, who: "input" | "output", text: string, done = false) {
  if (!text) return;
  const previous = call[who];
  const finalized = call[`${who}Final`];
  if (finalized && call.lastRole === who && (text === previous || (!done && previous.endsWith(text)))) return;
  const newTurn = !previous || finalized;
  if (newTurn) call[`${who}Turn`]++;
  const next = newTurn ? text : done ? (previous.startsWith(text) ? previous : text) : text.startsWith(previous) ? text : previous.endsWith(text) ? previous : previous + text;
  const delta = newTurn ? next : next.startsWith(previous) ? next.slice(previous.length) : "";
  if (next !== previous || newTurn) emit(call, { kind: who, delta, text: next, turn: call[`${who}Turn`] });
  call[who] = next;
  call[`${who}Final`] = done;
  call.lastRole = who;
}

function receive(call: Call, raw: string, auth: CodexAuth) {
  if (call.closed) return;
  let e;
  try { e = JSON.parse(raw); } catch { return; }
  if (e.type === "session.started") emit(call, { kind: "started" });
  else if (e.type === "session.closed") finish(call);
  else if ((e.type === "input_transcript.added" || e.type === "output_transcript.added") && typeof e.item?.text === "string") caption(call, e.type === "input_transcript.added" ? "input" : "output", e.item.text);
  else if (e.type === "turn.done" && typeof e.turn?.transcript === "string" && ["user", "assistant"].includes(e.turn.role)) caption(call, e.turn.role === "user" ? "input" : "output", e.turn.transcript, true);
  else if (e.type === "delegation.created" && e.item?.target === "client" && typeof e.item.id === "string") {
    emit(call, { kind: "delegation", id: e.item.id, request: (e.item.content ?? []).filter((c: { type: string; text?: unknown }) => c.type === "input_text" && typeof c.text === "string").map((c: { text: string }) => c.text).join("\n") });
  } else if (e.type === "error") {
    const error = failure(0, e.error ?? { message: e.message }, new Headers(), auth);
    emit(call, { kind: "error", message: error.message });
    if (call.socket.readyState === WebSocket.OPEN) { call.socket.send(JSON.stringify({ type: "session.close" })); call.socket.close(); }
    finish(call);
  }
}

async function open(callId: string, auth: CodexAuth, session: string, realtime: string) {
  const base = (process.env.BOPS_VOICE_SIDEBAND_BASE?.trim() || "wss://api.openai.com/v1/live").replace(/\/+$/, "");
  const socket = new WebSocket(`${base}/${encodeURIComponent(callId)}`, { headers: headers(auth, session, realtime), handshakeTimeout: 15_000 });
  const call: Call = { socket, events: [], base: 0, input: "", output: "", closed: false, inputFinal: false, outputFinal: false, inputTurn: 0, outputTurn: 0 };
  // Install listeners before open: session.started can arrive immediately after the handshake.
  socket.on("message", (data) => receive(call, String(data), auth));
  socket.on("close", () => finish(call));
  socket.on("error", () => { if (!call.closed) { emit(call, { kind: "error", message: "ChatGPT's voice connection stopped. Please call again." }); finish(call); } });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", () => reject(new Error("ChatGPT's voice sideband couldn't connect."))); socket.once("close", () => reject(new Error("ChatGPT's voice sideband closed before connecting."))); });
  calls.set(callId, call);
  renewIdle(call);
  return call;
}

function chunks(text: string) {
  const result: string[] = [];
  let chunk = "", size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > 500) { result.push(chunk); chunk = ""; size = 0; }
    chunk += character; size += bytes;
  }
  result.push(chunk);
  return result;
}

export const codexVoiceRuntime: VoiceRuntime = {
  chooseVoice(bot: Bot) {
    return voiceOnPlan(bot);
  },
  async answer(input) {
    const { sdp, callId, auth, session, realtime } = await signal(input);
    await open(callId, auth, session, realtime);
    return { sdp, sessionId: callId, client: { transport: "server", callId } };
  },
  async say(callId, text, delegationId, complete) {
    const call = calls.get(callId);
    if (!call || call.closed || call.socket.readyState !== WebSocket.OPEN) throw new Error("This voice call has ended.");
    for (const chunk of chunks(text)) call.socket.send(JSON.stringify({ type: delegationId ? "delegation.context.append" : "session.context.append", ...(delegationId ? { delegation_item_id: delegationId } : {}), ...(complete ? {} : { channel: "commentary" }), content: [{ type: "input_text", text: chunk }] }));
    renewIdle(call);
  },
  async close(callId) {
    const call = calls.get(callId);
    if (!call || call.closed) return;
    if (call.socket.readyState === WebSocket.OPEN) { call.socket.send(JSON.stringify({ type: "session.close" })); call.socket.close(); }
    else call.socket.terminate();
    finish(call);
  },
  events(callId, after) {
    const call = calls.get(callId);
    if (call) renewIdle(call);
    return call ? { events: call.events.slice(Math.max(0, after - call.base)), cursor: call.base + call.events.length } : null;
  },
};
