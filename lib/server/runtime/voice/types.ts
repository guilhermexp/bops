import type { Bot } from "@/lib/types";

/**
 * The voice capability: one live call with a bot, started from the browser's WebRTC offer. The page
 * plays the audio. It learns captions and delegations from `client`, which is everything it needs
 * and never a token. Each runtime implements VoiceRuntime; call.ts and the call route only know these
 * types.
 */

/** What the page should show or do. Deltas append; a delegation is something the user asked to be done. */
export type VoiceEvent =
  | { kind: "started" }
  | { kind: "closed" }
  | { kind: "input"; delta: string; text?: string; turn?: number }
  | { kind: "output"; delta: string; text?: string; turn?: number }
  | { kind: "delegation"; id: string; request: string }
  | { kind: "error"; message: string };

/**
 * How the page hears the call and speaks back. `data-channel`: on its own WebRTC data channel, with
 * these event names. `server`: the server holds the far side and the page reads events and posts
 * what to say. Either way the token stays on the server.
 */
export type VoiceClient =
  | { transport: "server"; callId: string }
  | {
      transport: "data-channel";
      channel: string;
      started: string;
      closed: string;
      input: string;
      output: string;
      delegation: string;
      commentary: string;
      close: string;
    };

/** The browser's answer: SDP to set as the remote description, and `client` for everything else. */
export type VoiceAnswer = { sdp: string; sessionId: string; client: VoiceClient };

export type VoiceStart = { sdp: string; instructions: string; voice: string; botId: string };

export type VoiceRuntime = {
  chooseVoice(bot: Bot): Promise<string>;
  answer(input: VoiceStart): Promise<VoiceAnswer>;
  /** Text the model should take in: a greeting, progress, or a result. `delegationId` ties it to one the model opened. */
  say(callId: string, text: string, delegationId: string | null, complete?: boolean): Promise<void>;
  close(callId: string): Promise<void>;
  /** Events since `after` (a cursor). Null when this runtime has no such call. */
  events(callId: string, after: number): { events: VoiceEvent[]; cursor: number } | null;
};

/** Context for the model, or a request to stop; completion matters only to server transports. */
export type VoiceControl = { type: string; delegation_id?: string | null; content?: string; complete?: boolean };
