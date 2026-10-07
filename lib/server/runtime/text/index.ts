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
