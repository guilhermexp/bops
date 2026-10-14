import "server-only";
import { ownerName } from "./store";
import { ABOUT_BOPS as UPSTREAM_ABOUT_BOPS } from "@/cloud/style";

/**
 * How every bot writes and speaks (WRITING, SPEAKING), what it knows about Bops (ABOUT_BOPS), how it
 * asks (ASKING) and how its answer is tidied (tidyAnswer). Shared text lives in cloud/style.ts, which
 * Bops Cloud imports too; this server adapts its computer policy for the private task runtimes.
 */
export { ASKING, SPEAKING, tidyAnswer, WRITING } from "@/cloud/style";

const COMPUTER_GUIDANCE =
  "- Computers: Each bot has a task computer on Bops' configured host. On cloud hosts, each computer has a browser and 4 screens for parallel work. On a Mac-hosted server, a task with where cloud uses the bot's isolated Chrome profile on that Mac, not the user's personal browser.";
const MAC_GUIDANCE = [
  "- The user's Mac: Native \"Your Mac\" tasks always use Codex and its app-approval flow, regardless of task runtime. They do not depend on Full Access.",
  "On a Mac-hosted server, where cloud uses the bot's separate Chrome profile. Full Access affects only OpenAI browser tasks on a Mac-hosted server. When on, that path can use a shell, local files and Mac apps. When off, those local capabilities are unavailable through that path.",
  "OpenAI work uses the configured API key, or Bops Cloud AI credit when routed through Bops Cloud. Codex text, task, and call work uses the ChatGPT plan signed in with Codex, with that plan's usage limits.",
  "The Your Mac tab shows what bots do there and the words that mean use the Mac.",
].join(" ");

/** The shared upstream prompt is also used by voice/call paths; adapt its computer policy once here. */
export const ABOUT_BOPS = UPSTREAM_ABOUT_BOPS
  .replace(/^- Computers:.*$/m, COMPUTER_GUIDANCE)
  .replace(/^- The user's Mac:.*$/m, MAC_GUIDANCE);

/** The computer briefing, wrapped so a bot reads it as background, not something to report. */
export const withBriefing = (input: string, brief: string) =>
  brief ? `${input}\n\n<computer_state note="Background for you only. Never quote, summarize or mention it to ${ownerName()}.">\n${brief}\n</computer_state>` : input;
