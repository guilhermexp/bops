import "server-only";
import type { Bot } from "@/lib/types";
import { runtimeFor, type RuntimeId } from "../config";
import { codexVoiceRuntime } from "./codex";
import { openaiVoice } from "./openai";
import { voiceFor, voiceOnPlan } from "./voices";
import type { VoiceRuntime } from "./types";

export { voiceFor, rememberVoices } from "./voices";

const runtimes: Record<RuntimeId, VoiceRuntime> = { openai: openaiVoice, codex: codexVoiceRuntime };

export async function answerVoice(bot: Bot, sdp: string, instructions: string) {
  const id = runtimeFor("voice");
  const voice = await (id === "codex" ? voiceOnPlan(bot) : voiceFor(bot));
  return runtimes[id].answer({ sdp, instructions, voice });
}

// Calls retain their runtime when settings change during a conversation.
export function voiceEvents(callId: string, after: number) {
  for (const runtime of Object.values(runtimes)) {
    const events = runtime.events(callId, after);
    if (events) return events;
  }
  return null;
}

function runtimeOf(callId: string) {
  const runtime = Object.values(runtimes).find((r) => r.events(callId, 0));
  if (!runtime) throw new Error("This voice call has ended.");
  return runtime;
}

export const sayVoice = (callId: string, text: string, delegationId: string | null = null, complete = false) => runtimeOf(callId).say(callId, text, delegationId, complete);
export const closeVoice = (callId: string) => runtimeOf(callId).close(callId);
export function requireSipVoice() {
  if (runtimeFor("voice") !== "openai") throw new Error("SIP calls need the OpenAI voice runtime. Set BOPS_VOICE_RUNTIME=openai. Calls in the app use your ChatGPT plan.");
}
