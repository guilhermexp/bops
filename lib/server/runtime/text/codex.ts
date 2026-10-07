import "server-only";
import { randomUUID } from "node:crypto";
import { codexResponses } from "../codex/client";
import { recordTokens } from "../../usage";
import { modelFor, type TextReply, type TextRequest, type TextRuntime } from "./types";

/**
 * Text on the user's ChatGPT plan, through the Codex backend (../codex/client.ts). Nothing is kept
 * there (store: false), so a tool loop sends the whole conversation again: what was asked, every item
 * answered (reasoning comes back encrypted, to be sent again as is), and the tools' outputs. Items are
 * sent without their ids, which only point at stored items. There's no cap on an answer's length.
 */

async function ask(req: TextRequest, input: unknown[], session: string): Promise<TextReply> {
  const model = modelFor(req.role);
  const answer = await codexResponses(
    {
      model,
      instructions: req.instructions,
      input,
      tools: req.tools ?? [],
      tool_choice: "auto",
      parallel_tool_calls: req.parallelTools ?? true,
      reasoning: { effort: req.effort },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: session,
      ...(req.json ? { text: { format: { type: "json_schema", name: req.json.name, strict: true, schema: req.json.schema } } } : {}),
    },
    session,
  );
  recordTokens(req.usage.source, answer.model ?? model, answer.usage, req.usage.botId);
  const said = answer.items.filter((i) => i.type === "message").flatMap((i) => (i.content as { type: string; text?: string }[] | undefined) ?? []);
  const sent = answer.items.map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== "id")));
  return {
    text: said
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join(""),
    calls: answer.items.flatMap((i) => (i.type === "function_call" ? [{ call_id: String(i.call_id), name: String(i.name), arguments: String(i.arguments ?? "") }] : [])),
    next: (outputs) => ask(req, [...input, ...sent, ...outputs.map((o) => ({ type: "function_call_output", call_id: o.call_id, output: o.output }))], session),
  };
}

export const codexText: TextRuntime = {
  respond: (req) => ask(req, typeof req.input === "string" ? [{ role: "user", content: req.input }] : req.input, randomUUID()),
  // The plan's own limit isn't checked ahead: the backend says so, and codexResponses keeps it until it resets.
  outOfCredit: async () => false,
};
