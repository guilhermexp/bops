import "server-only";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The user's ChatGPT sign-in, as Codex keeps it (`codex login`, or Sign in on Settings → This Mac):
 * ${CODEX_HOME:-~/.codex}/auth.json. Bops only reads that file. A refresh token works once, so if Bops
 * renewed the sign-in itself, the Codex CLI and app on this Mac would be signed out; instead Bops asks
 * Codex's app server to renew it (account/read with refreshToken) and reads the file again.
 */

/** Codex's own folder: its config.toml and auth.json. */
export const codexHome = () => process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");

/** Codex isn't signed in with a ChatGPT account (or the sign-in ran out): the app's setup card has the way in. */
export class CodexSignInError extends Error {
  readonly code = "codex_sign_in";
  constructor(message = "Codex isn't signed in with your ChatGPT account. Sign in from Settings → This Mac (Computer use on your Mac → Sign in).") {
    super(message);
  }
}

export const isCodexSignIn = (e: unknown): e is CodexSignInError => (e as { code?: unknown } | null)?.code === "codex_sign_in";

export type CodexAuth = {
  accessToken: string;
  accountId: string;
  /** The ChatGPT plan ("plus", "pro"…), when the token says. */
  plan?: string;
  /** When the access token expires (ms), when it says. */
  expiresAt?: number;
};

type AuthFile = { tokens?: { access_token?: string; account_id?: string } | null };
type Claims = { exp?: number; "https://api.openai.com/auth"?: { chatgpt_account_id?: string; chatgpt_plan_type?: string } };

function claims(jwt: string): Claims {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Claims;
  } catch {
    return {};
  }
}

/** The sign-in in auth.json now. Throws CodexSignInError when there's no ChatGPT sign-in. */
export function readCodexAuth(): CodexAuth {
  let file: AuthFile;
  try {
    file = JSON.parse(readFileSync(join(codexHome(), "auth.json"), "utf8")) as AuthFile;
  } catch {
    throw new CodexSignInError();
  }
  const accessToken = file.tokens?.access_token;
  if (!accessToken) throw new CodexSignInError();
  const c = claims(accessToken);
  const auth = c["https://api.openai.com/auth"];
  const accountId = file.tokens?.account_id || auth?.chatgpt_account_id;
  if (!accountId) throw new CodexSignInError();
  return { accessToken, accountId, plan: auth?.chatgpt_plan_type, expiresAt: c.exp ? c.exp * 1000 : undefined };
}

/** Renewed this long before the token says it expires. */
const EARLY_MS = 60_000;

const g = globalThis as unknown as { bopsCodexRenewal?: Promise<CodexAuth> };

/**
 * The sign-in to use for a call: auth.json's, renewed first when it has expired or `stale` (a token
 * the backend just turned down) is still what the file has. One renewal at a time.
 */
export async function codexAuth(stale?: string): Promise<CodexAuth> {
  const now = readCodexAuth();
  const expired = now.expiresAt !== undefined && now.expiresAt - EARLY_MS < Date.now();
  if (!expired && (stale === undefined || now.accessToken !== stale)) return now;
  g.bopsCodexRenewal ??= renew(now.accessToken).finally(() => (g.bopsCodexRenewal = undefined));
  return g.bopsCodexRenewal;
}

async function renew(was: string): Promise<CodexAuth> {
  // Load the transport only for renewal; it imports codexHome from here too.
  const { codex } = await import("../../codex");
  try {
    await codex.ready();
    const r = await codex.request<{ account?: { type?: string } | null }>("account/read", { refreshToken: true }, 30_000);
    if (r.account?.type !== "chatgpt") throw new CodexSignInError();
  } catch (e) {
    if (isCodexSignIn(e)) throw e;
    throw new Error(`Codex couldn't renew your ChatGPT sign-in (${(e as Error).message.replace(/\.$/, "")}).`);
  }
  const now = readCodexAuth();
  if (now.accessToken === was) throw new CodexSignInError("Your ChatGPT sign-in in Codex has run out. Sign in again from Settings → This Mac (Computer use on your Mac → Sign in).");
  return now;
}
