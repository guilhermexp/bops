import "server-only";
import { existsSync } from "node:fs";
import type { MacState } from "@/lib/types";
import { findCodex, installCodex, installStatus } from "./codex-cli";
import { CHROME } from "./local";
import { onPostgres } from "./persist";
import { runtimeFor } from "./runtime/config";
import { getState, stateReady, update } from "./store";

/** Mac readiness for the selected task runtime. OpenAI uses the upstream sandboxed executor;
 * Codex uses the private app server and the user's ChatGPT subscription. */
/** Apps and words that, named in a task, mean it belongs on the user's Mac (they can change the list). */
export const DEFAULT_MAC_RULES = ["Messages", "iMessage", "Notes", "Apple Mail", "Photos", "Finder", "Keynote", "Pages", "Numbers", "Xcode", "Reminders", "my desktop", "my Downloads", "my laptop", "my Mac"];

export const emptyMac = (): MacState => ({ ready: false, approvals: [], alwaysApps: [], rules: [...DEFAULT_MAC_RULES] });

/** This server runs on the user's Mac (not a hosted one), where bots can work. */
const onTheMac = () => process.platform === "darwin" && !onPostgres();

/**
 * Is the user's Mac ready for bots, and if not, the one thing it waits on: the Codex CLI that runs the
 * tools (Bops installs it when it's missing, once per start and again on Retry), or Chrome. Checked
 * now and then; the answer lives in state.mac.
 */
export async function checkMac() {
  // This Mac's readiness is kept in the signed-in user's state (state.mac, this Mac's own: state.macs):
  // none to keep it in signed out. A sign-in looks again once their state has loaded (orgo-sign-in.ts).
  if (process.env.NEXT_PHASE === "phase-production-build" || !stateReady()) return false;
  if (runtimeFor("tasks") === "codex") return (await import("./codex")).checkMac();
  let ready = false;
  let reason: string | undefined;
  let next: MacState["next"];
  if (!onTheMac()) {
    next = "elsewhere";
    reason = "Bots work on your Mac in the Bops app on your Mac.";
  } else if (!findCodex()) {
    if (!installStatus()) installCodex(() => void checkMac().catch(() => {}));
    const failed = installStatus()?.state === "failed" ? installStatus()?.error : undefined;
    next = "codex";
    reason = failed !== undefined ? `Couldn't install Codex. ${failed}` : "Installing Codex";
  } else if (!existsSync(CHROME)) {
    next = "chrome";
    reason = "Install Google Chrome so bots can work on this Mac";
  } else ready = true;
  const now = { ready, reason, next, installing: next === "codex" && installStatus()?.state === "installing" };
  // Only a change goes out to the app.
  const was = getState().mac;
  if (was && (Object.keys(now) as (keyof typeof now)[]).every((k) => was[k] === now[k])) return ready;
  update((state) => {
    state.mac ??= emptyMac();
    Object.assign(state.mac, { ...now, checkedAt: Date.now() });
  });
  return ready;
}

/** Retry: install the CLI again if it's still missing (a failed install isn't retried by itself), then look again. */
export async function retryCodex() {
  if (!findCodex() && onTheMac()) installCodex(() => void checkMac().catch(() => {}));
  await checkMac();
}

const g = globalThis as typeof globalThis & { __bopsMacCheck?: ReturnType<typeof setInterval> };
g.__bopsMacCheck ??= setInterval(() => void checkMac().catch(() => {}), 5 * 60_000);
void checkMac().catch(() => {});
