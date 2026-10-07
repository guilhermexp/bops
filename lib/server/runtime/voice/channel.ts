import type { VoiceClient, VoiceControl } from "./types";

/** Public event names come from the runtime; server-only completion hints stay off the wire. */
export function channelMessage(client: Extract<VoiceClient, { transport: "data-channel" }> | undefined, event: VoiceControl) {
  if (event.type === "session.close") return { type: client?.close ?? event.type };
  return { type: client?.commentary ?? event.type, delegation_id: event.delegation_id, content: event.content };
}
