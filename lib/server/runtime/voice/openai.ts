import "server-only";
import { noteOutOfCredit, OUT_OF_CREDIT } from "../../cloud";
import { openaiClient } from "../../openai-client";
import type { Bot } from "@/lib/types";
import { voiceFor } from "./voices";
import type { VoiceClient, VoiceRuntime } from "./types";

/**
 * Voice on OpenAI's API (gpt-live-1), the upstream call: the browser's data channel carries the
 * conversation, and this only exchanges the SDP. SIP trunks (phone.ts) are this runtime's too.
 */

const client = openaiClient({ maxRetries: 0 });

/** The event names the page already speaks on the data channel. Returning them keeps that wire unchanged. */
const PAGE: VoiceClient = {
  transport: "data-channel",
  channel: "oai-events",
  started: "session.started",
  closed: "session.closed",
  input: "session.input_transcript.delta",
  output: "session.output_transcript.delta",
  delegation: "session.delegation.created",
  commentary: "session.commentary.append",
  close: "session.close",
};

export const openaiVoice: VoiceRuntime = {
  chooseVoice(bot: Bot) {
    return voiceFor(bot);
  },
  async answer({ sdp, instructions, voice }) {
    try {
      const result = await client.live.create({
        session: { model: "gpt-live-1", instructions, audio: { output: { voice } }, delegation: { type: "client" } },
        transport: { type: "webrtc", sdp },
      } as never);
      const live = result as unknown as { session: { id: string }; transport: { sdp: string } };
      return { sdp: live.transport.sdp, sessionId: live.session.id, client: PAGE };
    } catch (e) {
      if (noteOutOfCredit(e)) throw new Error(OUT_OF_CREDIT);
      throw e;
    }
  },
  // The page sends these on its data channel. There is no server-side call to say them to.
  async say() {
    throw new Error("This call is spoken from the page.");
  },
  async close() {
    throw new Error("This call is closed from the page.");
  },
  events() {
    return null;
  },
};
