/**
 * Which runtime runs each capability (lib/server/runtime/AGENTS.md). `openai` is OpenAI's API (with
 * a key, or through Bops Cloud when signed in with Orgo); `codex` is the user's ChatGPT plan, through
 * the account they signed in to Codex with. BOPS_RUNTIME picks one for everything; BOPS_TEXT_RUNTIME,
 * BOPS_TASK_RUNTIME and BOPS_VOICE_RUNTIME pick one for a single capability. Read on every call, so a
 * test (or an edit to .env.local) applies at once.
 */

export const RUNTIMES = ["openai", "codex"] as const;
export type RuntimeId = (typeof RUNTIMES)[number];
export type Capability = "text" | "tasks" | "voice";

const OWN_VAR: Record<Capability, string> = { text: "BOPS_TEXT_RUNTIME", tasks: "BOPS_TASK_RUNTIME", voice: "BOPS_VOICE_RUNTIME" };

/** The runtime for a capability. An id Bops doesn't know is an error that says which ones it does: never a silent fallback. */
export function runtimeFor(capability: Capability): RuntimeId {
  const own = process.env[OWN_VAR[capability]]?.trim();
  const id = own || process.env.BOPS_RUNTIME?.trim() || "openai";
  if (!(RUNTIMES as readonly string[]).includes(id)) throw new Error(`Unknown runtime "${id}" in ${own ? OWN_VAR[capability] : "BOPS_RUNTIME"}. Use ${RUNTIMES.join(" or ")}.`);
  return id as RuntimeId;
}
