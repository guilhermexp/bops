import "server-only";
import type { Bot } from "@/lib/types";
import { chose, decide } from "../../decide";
import { getState, update } from "../../store";

// Voice groups are inherited local choices, not gender metadata supplied by the provider.
export const CODEX_MALE = ["arbor", "cove", "ember", "spruce"] as const;
export const CODEX_FEMALE = ["breeze", "juniper", "maple", "sol", "vale"] as const;
export const CODEX_CHIEF = "cove";

export function codexVoice(id: string, gender: "female" | "male") {
  const list = gender === "female" ? CODEX_FEMALE : CODEX_MALE;
  return list[[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % list.length];
}

const MALE = ["cedar", "ash", "echo", "ballad", "verse"];
const FEMALE = ["marin", "coral", "shimmer", "sage"];
const genders = new Map<string, "female" | "male">();
export async function voiceFor(b: Bot) {
  const voice = await chooseVoice(b);
  // Kept on the bot, so Bops Cloud answers its calls in the same voice while the Mac is away.
  if (b.voice !== voice) update(() => void (b.voice = voice));
  return voice;
}

/** Every bot's voice, chosen and kept (the phone's catch-up runs it): a new or renamed bot gets its own before its first call. */
export async function rememberVoices() {
  for (const b of getState().bots) await voiceFor(b);
}

async function chooseVoice(b: Bot, codex = false) {
  if (b.isMain && (b.name === "Boppy" || b.name === "Sam")) return codex ? CODEX_CHIEF : "cedar";
  let g = genders.get(b.name);
  if (!g) {
    const a = await decide(
      { name: b.name },
      {
        gender: {
          type: "choice",
          instructions: `As a person's first name, is "${b.name}" usually a woman's name or a man's name?`,
          criteria: { female: "Usually a woman's name", male: "Usually a man's name", unclear: "Could be either, or not a person's name" },
        },
      },
    );
    const c = chose(a?.gender);
    g = c?.choice === "female" && (c.probabilities.female ?? 0) >= 0.6 ? "female" : "male";
    if (c) genders.set(b.name, g);
  }
  if (codex) return codexVoice(b.id, g);
  const list = g === "female" ? FEMALE : MALE;
  return list[[...b.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % list.length];
}

export const voiceOnPlan = (b: Bot) => chooseVoice(b, true);
