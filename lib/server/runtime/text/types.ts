import type { UsageEvent } from "@/lib/types";

/**
 * The text capability: one model answer for a prompt and a conversation, with tools and structured
 * output. Every runtime that runs text implements TextRuntime; callers (chat.ts, memory.ts, watches.ts,
 * sessions.ts suggestReplies, phone-voice.ts) only know these types.
 */

export type TextPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" };
/** A message in the conversation: the user's (or another bot's, or a note from Bops) or this bot's own. */
export type TextMessage = { role: "user" | "assistant"; content: string | TextPart[] };
/** A function the model can call. */
export type TextTool = { type: "function"; name: string; description?: string; strict?: boolean; parameters: Record<string, unknown> };
export type ToolCall = { call_id: string; name: string; arguments: string };
export type ToolOutput = { call_id: string; output: string };

/** What a call is for, which picks its model. */
export type ModelRole = "chat" | "phone";

export type TextRequest = {
  role: ModelRole;
  effort: "low" | "medium" | "high";
  instructions: string;
  input: string | TextMessage[];
  tools?: TextTool[];
  /** false: at most one tool call per answer. */
  parallelTools?: false;
  /** JSON in this shape (strict) instead of words: the answer's text is the JSON. */
  json?: { name: string; schema: Record<string, unknown> };
  /** A turn someone is waiting on (a phone call): no retries, a cap on the answer's length, and nothing kept by the provider where it can choose. */
  quick?: { maxOutputTokens: number };
  /** Whose tokens these are, for the usage ledger (usage.ts). */
  usage: { source: NonNullable<UsageEvent["source"]>; botId?: string };
};

export type TextReply = {
  /** The answer's words (the JSON, with `json`). */
  text: string;
  /** The tools it called, in order. */
  calls: ToolCall[];
  /** The answer after these calls' outputs: a round of a tool loop, same instructions and tools. */
  next(outputs: ToolOutput[]): Promise<TextReply>;
};

export type TextRuntime = { respond(req: TextRequest): Promise<TextReply> };

const DEFAULT_MODEL = "gpt-6.1-sol";

/** The model for a role, the same in every runtime: BOPS_CHAT_MODEL for chat (and the small calls), BOPS_PHONE_MODEL (else the chat's) for calls. */
export function modelFor(role: ModelRole) {
  const chat = process.env.BOPS_CHAT_MODEL?.trim() || process.env.BOPS_SAM_MODEL?.trim();
  return (role === "phone" ? process.env.BOPS_PHONE_MODEL?.trim() || chat : chat) || DEFAULT_MODEL;
}
