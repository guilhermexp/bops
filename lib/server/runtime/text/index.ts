import "server-only";
import { runtimeFor, type RuntimeId } from "../config";
import { codexText } from "./codex";
import { openaiText } from "./openai";
import type { TextReply, TextRequest, TextRuntime } from "./types";

export type { TextMessage, TextReply, TextRequest, TextTool, ToolCall, ToolOutput } from "./types";

/** Text in each runtime. A new runtime adds its file here (lib/server/runtime/AGENTS.md). */
const TEXT: Record<RuntimeId, TextRuntime> = { openai: openaiText, codex: codexText };

/** One answer from the text runtime BOPS_TEXT_RUNTIME (else BOPS_RUNTIME) picks. An unknown id rejects. */
export async function generateText(req: TextRequest): Promise<TextReply> {
  return TEXT[runtimeFor("text")].respond(req);
}

/**
 * Whether a chat turn shouldn't start for want of credit, as the text runtime counts it: Bops Cloud's
 * AI credit only when text goes through the cloud (openai, signed in with Orgo); never on codex, whose
 * plan limit the backend reports itself. An unknown runtime says no here and fails at generateText.
 */
export async function textOutOfCredit(): Promise<boolean> {
  let id: RuntimeId;
  try {
    id = runtimeFor("text");
  } catch {
    return false;
  }
  return TEXT[id].outOfCredit();
}
