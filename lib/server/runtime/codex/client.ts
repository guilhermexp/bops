import "server-only";
import { arch, platform, release } from "node:os";
import { codexAuth, CodexSignInError, type CodexAuth } from "./auth";

/**
 * The backend the Codex CLI and app talk to, on the user's ChatGPT plan: OpenAI's Responses API in
 * shape, not its public API (chatgpt.com/backend-api/codex, which may change). Every request is
 * `store: false` and streamed (Server-Sent Events); it turns down `previous_response_id`,
 * `max_output_tokens` and sampling settings, so a conversation is sent whole every time.
 * BOPS_CODEX_BASE_URL points it elsewhere (a stand-in, in tests).
 */

export const codexBaseUrl = () => (process.env.BOPS_CODEX_BASE_URL?.trim() || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");

/** How long one answer may take (a chat turn with tools can think for a while). */
const TIMEOUT_MS = 5 * 60_000;
/** When ChatGPT doesn't say when its limit resets, Bops asks again after this long. */
const UNKNOWN_RESET_MS = 60_000;

/** The ChatGPT plan's usage limit is reached. Its message is what a bot says: whose limit, and when it's back. */
export class CodexLimitError extends Error {
  readonly code = "codex_limit";
  readonly resetsAt?: number;
  constructor(resetsAt?: number, plan?: string) {
    super(limitWords(resetsAt, plan));
    this.resetsAt = resetsAt;
  }
}

export const isCodexLimit = (e: unknown): e is CodexLimitError => (e as { code?: unknown } | null)?.code === "codex_limit";

function limitWords(resetsAt?: number, plan?: string) {
  const which = plan && plan !== "unknown" ? `your ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` : "your ChatGPT plan";
  const said = `I've hit the usage limit on ${which}, so I've stopped.`;
  if (!resetsAt) return `${said} It comes back in a little while.`;
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString()
    ? `${said} It's back at ${time}.`
    : `${said} It's back ${at.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} at ${time}.`;
}

/**
 * The limit last reached, for the account that reached it, until it resets: that account's calls fail
 * at once meanwhile, as a bot out of credit doesn't ask. Another account signed in to Codex isn't held by it.
 */
const g = globalThis as unknown as { bopsCodexLimit?: { accountId: string; until: number; resetsAt?: number; plan?: string } };

function reached(resetsAt: number | undefined, auth: CodexAuth) {
  g.bopsCodexLimit = { accountId: auth.accountId, until: resetsAt ?? Date.now() + UNKNOWN_RESET_MS, resetsAt, plan: auth.plan };
  return new CodexLimitError(resetsAt, auth.plan);
}

type Problem = { type?: string; code?: string; message?: string; resets_at?: number; resets_in_seconds?: number };

/** When the limit resets (ms): from the error, else from the windows (5 h, weekly) the headers say are used up. */
function resetOf(p: Problem | undefined, headers: Headers): number | undefined {
  if (typeof p?.resets_at === "number") return p.resets_at * 1000;
  if (typeof p?.resets_in_seconds === "number") return Date.now() + p.resets_in_seconds * 1000;
  const full = ["primary", "secondary"]
    .filter((w) => Number(headers.get(`x-codex-${w}-used-percent`)) >= 100)
    .map((w) => {
      const at = Number(headers.get(`x-codex-${w}-reset-at`));
      const after = Number(headers.get(`x-codex-${w}-reset-after-seconds`));
      return at > 0 ? at * 1000 : after > 0 ? Date.now() + after * 1000 : 0;
    })
    .filter((at) => at > 0);
  return full.length ? Math.max(...full) : undefined;
}

/** An error ChatGPT answered with, as Bops says it. */
function failure(p: Problem | undefined, status: number, headers: Headers, auth: CodexAuth): Error {
  const kind = p?.type ?? p?.code;
  if (kind === "usage_limit_reached" || kind === "rate_limit_exceeded" || status === 429) return reached(resetOf(p, headers), auth);
  if (status === 401) return new CodexSignInError("ChatGPT didn't accept your Codex sign-in. Sign in again from Settings → This Mac (Computer use on your Mac → Sign in).");
  if (kind === "usage_not_included") return new Error("Your ChatGPT plan doesn't include Codex, which Bops runs on. Set BOPS_RUNTIME=openai to use an OpenAI key instead.");
  return new Error(`ChatGPT couldn't answer${status ? ` (${status})` : ""}${p?.message ? `: ${p.message}` : "."}`);
}

export type CodexItem = Record<string, unknown> & { type: string };
export type CodexAnswer = { items: CodexItem[]; model?: string; usage?: { input_tokens: number; output_tokens: number } };

/**
 * One Responses request to the backend, on the user's sign-in: the items it answered with (reasoning,
 * messages, function calls) and its usage. A 401 renews the sign-in through Codex and tries once more.
 * `session` keeps a conversation's requests together (ChatGPT caches its prompt by it).
 */
export async function codexResponses(body: Record<string, unknown>, session: string): Promise<CodexAnswer> {
  let auth = await codexAuth();
  const standing = g.bopsCodexLimit;
  if (standing?.accountId === auth.accountId && Date.now() < standing.until) throw new CodexLimitError(standing.resetsAt, standing.plan);
  let res = await post(body, auth, session);
  if (res.status === 401) {
    await res.body?.cancel();
    auth = await codexAuth(auth.accessToken);
    res = await post(body, auth, session);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let p: Problem | undefined;
    try {
      const j = JSON.parse(raw) as { error?: Problem; detail?: unknown };
      p = j.error ?? (typeof j.detail === "string" ? { message: j.detail } : undefined);
    } catch {
      p = raw.trim() ? { message: raw.trim().slice(0, 300) } : undefined;
    }
    throw failure(p, res.status, res.headers, auth);
  }
  return read(res, auth);
}

async function post(body: Record<string, unknown>, auth: CodexAuth, session: string) {
  try {
    return await fetch(`${codexBaseUrl()}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        originator: "bops",
        "User-Agent": `bops (${platform()} ${release()}; ${arch()})`,
        "OpenAI-Beta": "responses=experimental",
        session_id: session,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, store: false, stream: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Couldn't reach ChatGPT (${(e as Error).message}). Check your internet connection.`);
  }
}

type StreamEvent = { type?: string; item?: CodexItem; response?: { model?: string; usage?: CodexAnswer["usage"]; error?: Problem; incomplete_details?: { reason?: string } }; error?: Problem; code?: string; message?: string };

/** The streamed answer: each output item as it's done, then response.completed with the usage. */
async function read(res: Response, auth: CodexAuth): Promise<CodexAnswer> {
  const items: CodexItem[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  let done: CodexAnswer | undefined;
  const handle = (block: string) => {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const e = JSON.parse(data) as StreamEvent;
    if (e.type === "response.output_item.done" && e.item) items.push(e.item);
    else if (e.type === "response.completed") done = { items, model: e.response?.model, usage: e.response?.usage };
    else if (e.type === "response.failed") throw failure(e.response?.error, 0, res.headers, auth);
    else if (e.type === "response.incomplete") throw new Error(`ChatGPT stopped before its answer was done (${e.response?.incomplete_details?.reason ?? "incomplete"}).`);
    else if (e.type === "error") throw failure(e.error ?? { code: e.code, message: e.message }, 0, res.headers, auth);
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handle(buf);
  if (!done) throw new Error("ChatGPT's answer was cut off.");
  return done;
}
