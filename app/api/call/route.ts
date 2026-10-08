import { closeVoice, sayVoice, voiceEvents } from "@/lib/server/runtime/voice/index";
import { delegate, endCall, startCall } from "@/lib/server/call";

/**
 * Calls with a bot, only from the app on this Mac, on the selected voice runtime:
 * - { action: "start", botId, sdp } → the GPT-Live session and its SDP answer
 * - { action: "delegate", botId, request } → what the bot did and said, to be spoken back
 * - { action: "end", botId, seconds } → notes the call in the chat
 */
export async function POST(request: Request) {
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname)) return Response.json({ error: "local only" }, { status: 403 });
  const body = (await request.json()) as { action: string; botId: string; callId?: string; content?: string; delegationId?: string; complete?: boolean; sdp?: string; request?: string; seconds?: number; transcript?: { who: string; text: string }[] };
  try {
    if (body.action === "start" && body.sdp) return Response.json(await startCall(body.botId, body.sdp), { status: 201 });
    if (body.action === "speak" && body.callId && typeof body.content === "string") {
      await sayVoice(body.callId, body.content, body.delegationId ?? null, body.complete === true);
      return Response.json({ ok: true });
    }
    if (body.action === "close" && body.callId) {
      await closeVoice(body.callId);
      return Response.json({ ok: true });
    }
    if (body.action === "delegate" && body.request?.trim()) return Response.json(await delegate(body.botId, body.request.trim()));
    if (body.action === "end") {
      endCall(body.botId, body.seconds ?? 0, body.transcript);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Caption and delegation events, with a cursor so polling never repeats them. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return Response.json({ error: "local only" }, { status: 403 });
  const after = Number(url.searchParams.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "bad cursor" }, { status: 400 });
  const result = voiceEvents(url.searchParams.get("callId") ?? "", after);
  return Response.json(result ?? { error: "This voice call has ended." }, { status: result ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
