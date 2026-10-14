import "server-only";
import type { FunctionTool, ResponseCreateParamsNonStreaming, ResponseInput } from "openai/resources/responses/responses";
import { creditsOut } from "../../cloud";
import { openaiClient } from "../../openai-client";
import { recordTokens, usageTags } from "../../usage";
import { modelFor, type TextReply, type TextRequest, type TextRuntime } from "./types";

/**
 * Text on OpenAI's Responses API: OPENAI_API_KEY, or through Bops Cloud when signed in with Orgo
 * (openai-client.ts). A tool loop continues from the last response (previous_response_id), so the
 * conversation isn't sent again.
 */

const client = openaiClient();

async function ask(req: TextRequest, input: TextRequest["input"] | ResponseInput, previous?: string): Promise<TextReply> {
  const body: ResponseCreateParamsNonStreaming = {
    model: modelFor(req.role, req.model),
    reasoning: { effort: req.effort },
    instructions: req.instructions,
    previous_response_id: previous,
    input: input as ResponseInput,
    tools: req.tools as FunctionTool[] | undefined,
    parallel_tool_calls: req.parallelTools,
    max_output_tokens: req.quick?.maxOutputTokens,
    store: req.quick || req.ephemeral ? false : undefined,
    text: req.json ? { format: { type: "json_schema", name: req.json.name, strict: true, schema: req.json.schema } } : undefined,
  };
  const res = await client.responses.create(body, {
    ...usageTags(req.usage.source, req.usage.botId),
    ...(req.transport?.timeoutMs ? { timeout: req.transport.timeoutMs } : {}),
    maxRetries: req.quick ? 0 : req.transport?.maxRetries,
  });
  recordTokens(req.usage.source, res.model, res.usage, req.usage.botId, req.usage.epoch);
  return {
    text: res.output_text ?? "",
    calls: res.output.flatMap((o) => (o.type === "function_call" ? [{ call_id: o.call_id, name: o.name, arguments: o.arguments }] : [])),
    next: (outputs) => ask(req, outputs.map((o) => ({ type: "function_call_output" as const, call_id: o.call_id, output: o.output })), res.id),
  };
}

// Bops Cloud's AI credit (creditsOut is false unless text goes through the cloud).
export const openaiText: TextRuntime = { respond: (req) => ask(req, req.input), outOfCredit: creditsOut };
