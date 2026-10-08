import "server-only";
import { runtimeFor, type RuntimeId } from "../config";
import { codexText } from "./codex";
import { openaiText } from "./openai";
import type { TextReply, TextRequest, TextRuntime } from "./types";

export type { TextMessage, TextReply, TextRequest, TextTool, ToolCall, ToolOutput } from "./types";

/** Text implementations in the runtimes that support it. */
const TEXT: Partial<Record<RuntimeId, TextRuntime>> = { openai: openaiText, codex: codexText };

function textRuntime(id: RuntimeId): TextRuntime {
  const runtime = TEXT[id];
  if (!runtime) throw new Error(`Runtime "${id}" doesn't support text. Use ${Object.keys(TEXT).map((id) => `BOPS_TEXT_RUNTIME=${id}`).join(" or ")}.`);
  return runtime;
}

/** One answer from the text runtime BOPS_TEXT_RUNTIME (else BOPS_RUNTIME) picks. An unknown id rejects. */
export async function generateText(req: TextRequest): Promise<TextReply> {
  return textRuntime(runtimeFor("text")).respond(req);
}

/**
 * Whether a chat turn shouldn't start for want of credit, as the text runtime counts it: Bops Cloud's
 * AI credit only when text goes through the cloud (openai, signed in with Orgo); other providers report
 * their own limits. An unknown id says no here and fails at generateText.
 */
export async function textOutOfCredit(): Promise<boolean> {
  let id: RuntimeId;
  try {
    id = runtimeFor("text");
  } catch {
    return false;
  }
  return textRuntime(id).outOfCredit();
}
