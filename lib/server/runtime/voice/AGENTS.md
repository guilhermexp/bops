# lib/server/runtime/voice — live calls

## Purpose

The app's live voice capability. The browser owns microphone and WebRTC audio; `index.ts` selects the voice runtime and callers use its interface. Legacy SIP belongs to OpenAI. AgentPhone continues to use the text capability.

## Ownership

Voice runtime, `../../call.ts`, `../../phone.ts` (SIP guard), app call route, OpenAI phone webhook and CallBar. Shared runtime/config/auth/types and parent docs belong to the runtime core/Main.

## Local Contracts

- `types.ts`: normalized caption/delegation events, SDP answer and public transport description. `VoiceStart` includes the bot id so OpenAI requests through Bops Cloud carry the call's usage tags. Each `VoiceRuntime` implements `chooseVoice(bot)` as well as signaling/control/events; `index.ts` delegates voice choice to the selected runtime. No credentials in any browser response. Each call retains its selected runtime even if environment settings change.
- OpenAI keeps the `gpt-live-1` request, API/cloud client, stored voice and `oai-events` channel. The renderer still sends greeting, commentary and close over its channel.
- Codex signals `{BOPS_CODEX_BASE_URL}/realtime/calls?intent=quicksilver&architecture=avas` with `gpt-live-1-codex`, using `codexAuth` (read-only login, app-server renewal after one 401). Headers identify Codex Desktop, an explicit owner decision. `BOPS_CODEX_CLIENT_VERSION` defaults to `0.161.0` (the CLI version used for verification).
- Authenticated sideband stays on the server: `wss://api.openai.com/v1/live/<rtc_id>`. `BOPS_VOICE_SIDEBAND_BASE` overrides this for localhost tests. No attestation is synthesized: connection without it was observed in the real backend on this machine.
- Frameless Bidi is contained in `codex.ts`. Context is split at Unicode character boundaries into at most 500 UTF-8 bytes. Progress/greeting uses commentary; completed delegation results omit channel (the OMP response convention). Snapshot and incremental captions are normalized by turn; final and late repeated snapshots do not duplicate transcript text.
- Browser polls normalized events with a cursor, every 150 ms while active; the queue retains 2000 events. Explicit close, provider errors and provider `session.closed` close the sideband and detach its message listener. Closed calls remain available for 60 seconds; polling terminal captions never prolongs retention. Abandoned calls expire after one hour of inactivity, renewed by successful event polling or context/delegation control. WebRTC/channel close, errors, unmount and hang-up record the call once per browser mount.
- Minutes and long-term memory retain their existing behavior. A separate system message contains the readable transcript, because chat call cards render only duration.
- SIP guard runs before webhook parsing/API requests and before `incomingCall`: Codex voice produces a clear refusal naming `BOPS_VOICE_RUNTIME=openai`.

### Voice choices

The provider's `thread/realtime/listVoices` returns names, not gender. The name rule is the existing Jev classifier (female probability at least 0.6; ambiguous or unavailable = male), cached by name. Each runtime owns its pool and implements `chooseVoice(bot)`. OpenAI delegates to the existing `voiceFor`, preserving its pool and persisted `bot.voice`; Codex delegates to `voiceOnPlan` and does not overwrite the Cloud/SIP voice.

The following are local presentation choices inherited from the voice prototype, not a statement about the performers' identities or provider metadata:

| Voice | Local pool | Basis |
|---|---|---|
| arbor | male | Inherited male presentation pool |
| cove | male | Inherited male presentation pool; Boppy's real call verified |
| ember | male | Inherited male presentation pool |
| spruce | male | Inherited male presentation pool |
| breeze | female | Inherited female presentation pool |
| juniper | female | Inherited female presentation pool |
| maple | female | Inherited female presentation pool |
| sol | female | Inherited female presentation pool |
| vale | female | Inherited female presentation pool |

Boppy/Sam use cove deterministically. The nine supported identifiers and default cove were checked against Codex CLI 0.161.0; presentation of the other voices has not been independently auditioned in this run. [OpenAI's voice catalog](https://help.openai.com/en/articles/20001274-chatgpt-voice) lists presentation adjectives, without gender. [OpenAI's casting description](https://openai.com/index/how-the-voices-for-chatgpt-were-chosen/) explains the original voices' origin; it does not establish the pools above.

## Work Guidance

- Keep protocol/provider imports in runtime files. Import the capability with explicit `index`, for the script module hooks.
- Preserve `~/.codex/auth.json`: never write it, refresh tokens or expose bearer headers in logs/errors. Error text redacts the access token and carries the core sign-in/limit messages.
- CallBar never interprets Codex wire messages. Its server path consumes normalized events; OpenAI's public data-channel event names come from the server.

## Verification

`node --conditions=react-server scripts/test-runtime-voice.mjs`: localhost signaling, sideband and text fakes; temporary Codex home/state; network fetch guard. Covers runtime-owned voice selection with a test-only third runtime, SDP/headers/secrets, deterministic voices, captions/turn deduplication, delegation with a persisted routine, chunks, close/provider error, provider closure with an otherwise open socket, renewed idle expiry (virtual clock), terminal retention, visible transcript note/minutes, renewal, sign-in, account limit, OpenAI parity, SIP refusal. Also run the parent phone/text suites, Next typegen, typecheck and lint.

Real proof follows the root DOX isolation recipe: localhost:3331, disposable Chrome with synthesized local WAV microphone, separate `.data`, owner-state digest unchanged. Record signaling, greeting, spoken answer, delegated reminder, hang-up/transcript/minutes and latency in ignored evidence. Only stop processes created by the test.

## Child DOX Index

None.
