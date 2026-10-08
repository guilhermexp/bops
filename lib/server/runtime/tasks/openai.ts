import "server-only";
import type { ChildProcess } from "node:child_process";
import { openaiClient } from "../../openai-client";
import { creditsOut, executorKey } from "../../cloud";
import { browserMcp, startExecutor } from "../../local";
import { orgo } from "../../orgo";
import { bot, patchSession, session, stateEpoch } from "../../store";
import { workComputer } from "../../screens";
import { DISPLAYS } from "@/lib/types";
import { recordTokens } from "../../usage";
import { taskModel, type TasksRuntime, type TaskTurn, type TaskPlace, type TaskHooks } from "./types";

const client = openaiClient();
const TURN_TIMEOUT_MS = 10 * 60_000;
type OpenState = { id: string; env: { id: string; remoteUrl: string } };
type OpenThread = OpenState & { place: TaskPlace; executor?: ChildProcess; seen: Set<string> };

export const openaiTasks: TasksRuntime = {
  releaseScreens: true,
  resume(session) { return session.taskState !== undefined ? session.taskState : (session.agentSessionId && session.env ? { id: session.agentSessionId, env: session.env } : undefined); },
  snapshot(thread) { const { id, env } = thread as OpenThread; return { id, env }; },
  assertHost() {},
  outOfCredit: creditsOut,
  async open(req) {
    const { place } = req;
    const mac = place.host === "mac";
    const workspace = place.workspace;
    let thread = req.resume as OpenState | undefined;
    if (!thread) {
      const created = await client.beta.agents.sessions.create({
        agent: {
          model: taskModel(req.effort),
          reasoning: { effort: req.effort, summary: "auto" },
          instructions: req.instructions,
          tools: [
            { type: "web_search", mode: "live", context_size: "medium" },
            ...(mac ? [] : [{ type: "mcp", server_label: "browser", transport: {
              type: "stdio", command: "/usr/bin/node",
              args: ["/opt/bops/pw/node_modules/@playwright/mcp/cli.js", "--cdp-endpoint", `http://127.0.0.1:${9200 + place.display}`, "--init-page", "/opt/bops/pw/front.cjs"], cwd: "/workspace",
            }, required: false }]),
            { type: "mcp", server_label: mac ? "browser" : "screen", transport: mac ? browserMcp(place.cdpPort) : {
              type: "stdio", command: "/opt/bops/venv/bin/python",
              args: ["/opt/bops/screen_mcp.py", "stdio", "--session", place.sessionId, "--bot", place.botId], cwd: "/workspace", env_vars: ["DISPLAY"],
            }, required: true },
          ],
          ...(mac ? {} : { multi_agent: { enabled: true, max_concurrent_subagents: 3 } }),
        },
        environment: { type: "self_hosted", workspace_directory: workspace, capability_directories: [`${workspace}/capabilities/skills`] },
      } as never) as unknown as { id: string; environment: { id: string; remote_url: string } };
      thread = { id: created.id, env: { id: created.environment.id, remoteUrl: created.environment.remote_url } };
    }
    const env = thread.env!;
    const opened: OpenThread = { ...thread, place, seen: new Set() };
    req.opened?.(opened);
    try {
      if (mac) opened.executor = await startExecutor(env.id, env.remoteUrl, place.cdpPort);
      else await startOrgoExecutor(place.computerId, place.display, env);
    } catch (e) {
      await this.close(opened);
      throw e;
    }
    return opened;
  },
  async turn(req) {
    await runTurn(req, (req.thread as OpenThread).seen);
    return finalAnswer(req.thread.id);
  },
  async close(thread) {
    const opened = thread as OpenThread;
    opened.executor?.kill();
    if (opened.place.host === "orgo") {
      const { computerId, display } = opened.place;
      await orgo.bash(computerId, `pkill -f "[e]nvironment-id ${opened.env.id}"; rm -f /root/.bops/executor-key-${display}`, 15).catch(() => {});
    }
  },
};

async function startOrgoExecutor(computerId: string, display: number, env: { id: string; remoteUrl: string }) {
  const key = Buffer.from(await executorKey()).toString("base64");
  const started = await orgo.bash(
    computerId,
    [
      "mkdir -p /root/.bops && chmod 700 /root/.bops",
      `echo ${key} | base64 -d > /root/.bops/executor-key-${display} && chmod 600 /root/.bops/executor-key-${display}`,
      `bops-exec ${display} '${env.id}' '${env.remoteUrl}'`,
    ].join("\n"),
    30,
  );
  if (started.exit_code !== 0) throw new Error(`executor failed: ${started.output.slice(0, 200)}`);
}

async function runTurn(req: TaskTurn, seen: Set<string>) {
  const { input, hooks } = req;
  const sessionId = req.sessionId ?? "";
  const agentSessionId = req.thread.id;
  const stream = await client.beta.agents.sessions.events.stream(agentSessionId);
  hooks.bindStop(() => stream.controller.abort());
  await client.beta.agents.sessions.events.create(agentSessionId, {
    events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: input }] }] }],
  } as never);

  const poll = setInterval(() => void syncSteps(sessionId, agentSessionId, seen, hooks), 2500);
  const timeout = setTimeout(() => stream.controller.abort(), TURN_TIMEOUT_MS);
  let failure: string | undefined = "The session ended without finishing";
  // Which turns are helpers', so items streamed live can be credited to them.
  const turnOwner = new Map<string, string | null>();
  // Each turn's tokens (the thread's and its helpers'), counted once when it ends; `seen` keeps it once.
  const s = session(sessionId);
  const model = taskModel(req.effort);
  // Whose state this turn belongs to: tokens counted after a hosted server swapped users are dropped (stateEpoch).
  const epoch = req.epoch;
  const countTurn = (turnId: string, usage: TokenCount) => {
    if (!usage || seen.has(`turn:${turnId}`)) return;
    seen.add(`turn:${turnId}`);
    recordTokens("session", model, usage, s?.botId, epoch);
  };
  try {
    for await (const event of stream as AsyncIterable<{
      type: string;
      turn_id?: string | null;
      item?: Item;
      turn?: { subagent_id?: string | null; error?: { message?: string }; usage?: TokenCount };
      subagent?: { id: string; name: string | null };
      usage?: TokenCount;
    }>) {
      if (event.type === "agent.session.turn.created" && event.turn_id) turnOwner.set(event.turn_id, event.turn?.subagent_id ?? null);
      if (/^agent\.session\.turn\.(completed|failed|cancelled)$/.test(event.type) && event.turn_id) countTurn(event.turn_id, event.usage ?? event.turn?.usage);
      // A helper's name the moment it starts, so its work (and the screen it's on) is credited to it right away.
      if (event.type === "agent.session.subagent.created" && event.subagent?.name) {
        const { id: helperId, name } = event.subagent;
        helperNameById.set(helperId, name);
        patchSession(sessionId, (x) => {
          if (!x.helperNames?.includes(name)) x.helperNames = [...(x.helperNames ?? []), name];
        });
      }
      // Steps as they happen: the items list only fills in once a turn is over, so polling alone left
      // threads looking idle (and their captions stale) until the end.
      if (event.type === "agent.session.turn.item.done" && event.item) {
        const sub = event.turn_id ? turnOwner.get(event.turn_id) : null;
        const who = sub ? helperNameById.get(sub) : undefined;
        // A helper's item before its name is known waits for the next poll, so it's never shown as the thread's own.
        if (!sub || who) {
          const changed = recordItem(sessionId, event.item, seen, hooks, who);
          if (changed) void syncHelperScreens(sessionId);
        }
      }
      const root = !event.turn?.subagent_id;
      if (event.type === "agent.session.turn.completed" && root) {
        failure = undefined;
        break;
      }
      if ((event.type === "agent.session.turn.failed" && root) || event.type === "agent.session.failed" || event.type === "agent.session.environment.failed") {
        failure = event.turn?.error?.message ?? event.type;
        break;
      }
    }
  } catch (e) {
    failure = hooks.isStopped() ? "Stopped by you" : (e as Error).name === "AbortError" ? "Timed out after 10 minutes" : (e as Error).message;
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
    stream.controller.abort();
  }
  // Turns that end out of sight (a helper finishing after the thread, a timeout, a stop: the turn
  // keeps running on the server) are looked up until they finish, off the hot path.
  for (const turnId of turnOwner.keys())
    if (!seen.has(`turn:${turnId}`)) {
      seen.add(`turn:${turnId}`);
      settleTurn(turnId, agentSessionId, model, s?.botId, epoch);
    }
  await syncSteps(sessionId, agentSessionId, seen, hooks);
  if (failure) throw new Error(failure);
}

/** Turns being looked up until they finish, so each is counted once even across runs. */
const settling = new Set<string>();
/** Waits between lookups of a turn that hasn't finished: about two hours in all, then it's dropped. */
const SETTLE_WAITS_MS = [15_000, 30_000, 60_000, 120_000, ...Array<number>(28).fill(240_000)];

/** Record a turn's tokens once it reaches its end, asking again (further apart each time) while it runs. */
function settleTurn(turnId: string, agentSessionId: string, model: string, botId: string | undefined, epoch: number, attempt = 0) {
  if (attempt === 0 && settling.has(turnId)) return;
  settling.add(turnId);
  const retry = () => {
    // Another user's state is in memory now (hosted): this turn's tokens aren't theirs, so stop asking.
    if (epoch !== stateEpoch()) settling.delete(turnId);
    else if (attempt < SETTLE_WAITS_MS.length) setTimeout(() => settleTurn(turnId, agentSessionId, model, botId, epoch, attempt + 1), SETTLE_WAITS_MS[attempt]).unref?.();
    else settling.delete(turnId);
  };
  client.beta.agents.sessions.turns
    .retrieve(turnId, { session_id: agentSessionId })
    .then((t) => {
      if (!["completed", "failed", "cancelled"].includes(t.status)) return retry();
      settling.delete(turnId);
      recordTokens("session", model, t.usage, botId, epoch);
    })
    .catch(retry);
}

/** An agent turn's tokens, as the Agents API reports them (null when it doesn't know). */
type TokenCount = { input_tokens: number; output_tokens: number } | null | undefined;

type Item = {
  id: string;
  type: string;
  turn_id?: string;
  role?: string;
  phase?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
  output?: { content?: { type: string; text?: string }[] } | string | null;
  /** A web search's action: search (query), open_page (url), find_in_page (pattern in url). */
  action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string } | null;
  /** A shell command it ran. */
  command?: string;
  /** Reasoning summaries: what it's thinking about, in a line or two. */
  summary?: { text: string }[];
};

/** Mirror the agent's screen actions and narration into the thread. */
/**
 * Mirror the agent's screen actions and narration into the thread, including its helpers' (each
 * subagent keeps its own history; their steps are labelled with the helper's name and the screen
 * it acted on), and keep the thread's record of helper screens in step with the computer's ledger.
 */
const closedHelpers = new Set<string>();
/** Helpers' names by subagent id, learned when listing them, so live items can say who did them. */
const helperNameById = new Map<string, string>();

/** Turn one finished item into a thread step (once). True when it changed who holds which screen. */
function recordItem(sessionId: string, item: Item, seen: Set<string>, hooks: TaskHooks, who?: string) {
  if (seen.has(item.id)) return false;
  seen.add(item.id);
  const screen = typeof item.arguments?.screen === "number" ? item.arguments.screen : undefined;
  if (item.type === "mcp_call") hooks.step(item.name ?? "tool", describe(item.name, item.arguments), { who, screen });
  // Each helper's screen, in the order they start (so names line up), and its job as Sam named it.
  if (item.type === "mcp_call" && item.name === "claim_screen") {
    const out = typeof item.output === "string" ? item.output : (item.output?.content ?? []).map((c) => c.text ?? "").join(" ");
    const n = Number(out.match(/Screen (\d) is yours/)?.[1]);
    const task = typeof item.arguments?.task === "string" ? item.arguments.task.trim().slice(0, 60) : "";
    if (n)
      patchSession(sessionId, (x) => {
        const d = DISPLAYS[n - 1];
        x.helperOrder = [...(x.helperOrder ?? []).filter((y) => y !== d), d];
        if (task) x.helperTasks = { ...x.helperTasks, [d]: task };
      });
  }
  else if (item.type === "web_search_call") hooks.step("search", describeSearch(item.action), { who });
  else if (item.type === "command_execution") hooks.step("command", `ran ${String(item.command ?? "a command").slice(0, 100)}`, { who });
  // What it's thinking, as the thread's live caption (the thread's own, not its helpers').
  else if (item.type === "reasoning" && !who && item.summary?.length) {
    const line = item.summary.map((x) => x.text).join(" ").replace(/\*\*/g, "").split(/(?<=[.!?])\s/)[0].trim();
    if (line) hooks.caption(line.charAt(0).toLowerCase() + line.slice(1, 60).replace(/[.!?]$/, ""));
  }
  else if (item.type === "create_subagent_call") hooks.step("helper", "started a helper", { who });
  else if (item.type === "wait_for_subagents_call") hooks.step("helper", "waiting for helpers", { who });
  else if (item.type === "message" && item.role === "assistant" && item.phase === "commentary")
    hooks.step("note", item.content?.map((c) => c.text).join(" ") ?? "", { who });
  return item.type === "mcp_call" && (item.name === "claim_screen" || item.name === "release_screen");
}

async function syncSteps(sessionId: string, agentSessionId: string, seen: Set<string>, hooks: TaskHooks) {
  try {
    const record = (item: Item, who?: string) => recordItem(sessionId, item, seen, hooks, who);

    const items: Item[] = [];
    for await (const item of client.beta.agents.sessions.items.list(agentSessionId) as AsyncIterable<Item>) items.push(item);
    let ledgerChanged = false;
    let started = false;
    for (const item of items.reverse().filter((i) => !seen.has(i.id))) {
      ledgerChanged = record(item) || ledgerChanged;
      started ||= item.type === "create_subagent_call";
    }

    // Helpers, by name, and whatever they've done since the last look.
    const known = session(sessionId)?.helperNames ?? [];
    if (started || known.length) {
      const helpers: { id: string; name: string; status: string }[] = [];
      for await (const h of client.beta.agents.sessions.subagents.list(agentSessionId) as AsyncIterable<{ id: string; name: string; status: string }>) helpers.push(h);
      helpers.reverse();
      for (const h of helpers) helperNameById.set(h.id, h.name);
      const names = helpers.map((h) => h.name);
      if (names.join() !== known.join()) patchSession(sessionId, { helperNames: names });
      for (const h of helpers) {
        if (closedHelpers.has(h.id)) continue;
        const theirs: Item[] = [];
        for await (const item of client.beta.agents.sessions.subagents.items.list(h.id, { session_id: agentSessionId, order: "asc" }) as AsyncIterable<Item>)
          theirs.push(item);
        for (const item of theirs.filter((i) => !seen.has(i.id))) record(item, h.name);
        if (h.status !== "active") closedHelpers.add(h.id);
      }
    }
    if (ledgerChanged) await syncHelperScreens(sessionId);
  } catch {
    /* transient; the next poll catches up */
  }
}

/** Read which screens this thread's helpers hold from the computer's screen ledger. */
async function syncHelperScreens(sessionId: string) {
  const s = session(sessionId);
  const b = s && bot(s.botId);
  const computerId = b && workComputer(b).computerId;
  if (!computerId) return;
  const out = await orgo.bash(computerId, "bops-screens list", 15);
  const ledger = JSON.parse(out.output.trim() || "{}") as Record<string, string>;
  const helperScreens = Object.entries(ledger)
    .filter(([, owner]) => owner === `helper:${sessionId}`)
    .map(([n]) => DISPLAYS[Number(n) - 1]);
  patchSession(sessionId, { helperScreens });
}

async function finalAnswer(agentSessionId: string) {
  // The session's own items are the thread's; helpers keep theirs separately and report back to it.
  for await (const item of client.beta.agents.sessions.items.list(agentSessionId) as AsyncIterable<Item>)
    if (item.type === "message" && item.role === "assistant" && item.phase === "final_answer")
      return item.content?.map((c) => c.text).join(" ").trim() || "Done.";
  return "Done.";
}

function describeSearch(a?: Item["action"]) {
  if (a?.type === "open_page" && a.url) return `read ${a.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}`;
  if (a?.type === "find_in_page") return `looked for "${String(a.pattern ?? "").slice(0, 40)}" in the page`;
  const q = a?.query ?? a?.queries?.join(", ");
  return q ? `searched "${q.slice(0, 70)}"` : "searched the web";
}

function describe(tool?: string, args?: Record<string, unknown>) {
  if (tool === "claim_screen") return args?.task ? `brought in a helper for ${String(args.task).slice(0, 60)}` : "brought in a helper";
  if (tool === "release_screen") return "a helper finished";
  if (tool === "screenshot" || tool === "browser_take_screenshot") return "looked at the screen";
  if (tool === "move") return "moved the pointer";
  if (tool === "wait" || tool === "browser_wait_for") return "waited for the page";
  if (tool === "drag") return "dragged";
  if (!args) return tool ?? "";
  if (tool === "type_text") return `typed "${String(args.text).slice(0, 60)}"`;
  if (tool === "key") return `pressed ${args.keys}`;
  if (tool === "click") return `clicked (${args.x}, ${args.y})`;
  if (tool === "scroll") return `scrolled ${args.direction}`;
  if (tool === "browser_navigate") return `opened ${args.url}`;
  if (tool === "browser_click") return `clicked ${args.element ?? args.ref}`;
  if (tool === "browser_type") return `typed "${String(args.text).slice(0, 60)}"`;
  if (tool === "browser_press_key") return `pressed ${args.key}`;
  if (tool === "browser_snapshot") return "read the page";
  if (tool === "browser_fill_form") return "filled in the form";
  if (tool === "browser_select_option") return `picked ${Array.isArray(args.values) ? args.values.join(", ") : "an option"}`;
  if (tool === "browser_tabs") return `${args.action ?? "switched"} a tab`;
  if (tool === "browser_hover") return `hovered ${args.element ?? ""}`.trim();
  return tool ?? "";
}

