import "server-only";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { openaiClient } from "../../openai-client";
import { AI_CREDIT_EMPTY, AI_CREDIT_LOW } from "@/cloud/protocol";
import { CloudError, creditsOut, executorKey, outOfCreditError } from "../../cloud";
import { appsMcp, appsSocket, browserMcp, cuaDriverHere, MAC_BROWSER_TOOLS, MAC_UI_TOOLS, macUiMcp, startExecutor, stopExecutor, taskDir, taskSockets } from "../../local";
import { orgo } from "../../orgo";
import { bot, patchSession, session, stateEpoch } from "../../store";
import { workComputer } from "../../screens";
import { DISPLAYS } from "@/lib/types";
import { computerToolOn, computerTurn } from "../../computer-task";
import { composioOn, accountsOf, serveApps } from "../../composio";
import { dataOn } from "../../treg";
import { fullAccessOn } from "../../full-access";
import { recordTokens, usageTags } from "../../usage";
import { taskModel, type TasksRuntime, type TaskTurn, type TaskPlace, type TaskHooks, type TaskSession, type TaskResumeContext } from "./types";

const client = openaiClient();
const TURN_IDLE_MS = 5 * 60_000;
const TURN_MAX_MS = 60 * 60_000;
const STALLED = `Stuck: nothing happened for ${TURN_IDLE_MS / 60_000} minutes`;
const TOO_LONG = `Ran for ${TURN_MAX_MS / 60_000} minutes without finishing`;
const CANCELLED_WAIT_MS = 90_000;
type OpenState = { runner?: undefined; id: string; env: NonNullable<TaskSession["env"]> };
type ComputerState = { runner: "computer"; id?: string };
type OpenThread = (OpenState | (ComputerState & { id: string })) & {
  ownerKey?: string;
  ownerToken: string;
  place: TaskPlace;
  instructions: string;
  fullAccess?: boolean;
  macApps?: boolean;
  macData?: boolean;
  macUi?: boolean;
  folder?: string;
  executor?: ChildProcess;
  closeApps?: () => void;
  seen: Set<string>;
};

/** A replacement run with the same persisted session id takes ownership before setup awaits. */
const taskOwners = new Map<string, string>();
const ownsTask = (thread: OpenThread) => !thread.ownerKey || taskOwners.get(thread.ownerKey) === thread.ownerToken;

function usesComputerTool(saved: TaskSession, place: TaskPlace) {
  return place.host === "orgo" && (saved.runner === "computer" || (!saved.agentSessionId && computerToolOn()));
}

function openState(value: unknown): value is OpenState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OpenState>;
  return typeof state.id === "string" && typeof state.env?.id === "string" && typeof state.env.remoteUrl === "string";
}

function computerState(value: unknown): value is ComputerState {
  return !!value && typeof value === "object" && (value as Partial<ComputerState>).runner === "computer";
}

export const openaiTasks: TasksRuntime = {
  releaseScreens: true,
  resume(saved: TaskSession) {
    if (computerState(saved.taskState) || openState(saved.taskState)) return saved.taskState;
    return saved.runner === "computer" || saved.responseId ? { runner: "computer" } : saved.agentSessionId && saved.env ? { id: saved.agentSessionId, env: saved.env } : undefined;
  },
  canResume(saved: TaskSession, context: TaskResumeContext) {
    const candidate = this.resume(saved) as OpenState | ComputerState | undefined;
    if (!candidate) return false;
    if ("runner" in candidate && candidate.runner === "computer") return true;
    const env = saved.env ?? (candidate as OpenState).env;
    if (!env) return false;
    if (context.place.host === "mac") {
      // Before Mac task configuration was persisted, legacy Agents threads only had their remote
      // environment id. Reuse those threads only with today's restricted browser-only setup; any
      // added Mac capability requires explicit metadata from the saved thread.
      if (!env.workspace) return !context.fullAccess && !context.macApps && !context.macData && !context.macUi && !env.fullAccess && !env.sockets && !env.apps && !env.data && env.ui !== true && env.ui !== "bops" && env.cdpPort === undefined && env.display === undefined && context.place.display === context.lastDisplay;
      const folder = context.sessionId ? taskDir(context.sessionId) : undefined;
      const sockets = folder ? taskSockets(folder) : undefined;
      return !!env.workspace &&
        env.workspace === context.place.workspace &&
        env.cdpPort === context.place.cdpPort &&
        env.display === context.place.display &&
        !!env.fullAccess === !!context.fullAccess &&
        env.sockets === sockets &&
        !!env.apps === !!context.macApps &&
        !!env.data === !!context.macData &&
        env.ui !== true &&
        (env.ui === "bops") === !!context.macUi;
    }
    return env.display === undefined || env.display === context.place.display;
  },
  snapshot(thread) {
    const opened = thread as OpenThread;
    return "runner" in opened && opened.runner === "computer" ? { runner: "computer" } : { id: opened.id, env: (opened as OpenState).env };
  },
  assertHost() {},
  outOfCredit: creditsOut,
  usesComputerTool,
  waitForUser(thread) {
    const sessionId = (thread as OpenThread).place?.sessionId;
    return !!sessionId && !!session(sessionId)?.owed?.some((item) => item.checks);
  },
  async open(req) {
    const epoch = req.epoch ?? stateEpoch();
    const { place } = req;
    const mac = place.host === "mac";
    const sessionId = req.sessionId ?? place.sessionId ?? "";
    const ownerKey = sessionId || undefined;
    const ownerToken = randomUUID();
    if (ownerKey) taskOwners.set(ownerKey, ownerToken);
    const owns = () => !ownerKey || taskOwners.get(ownerKey) === ownerToken;
    const current = () => epoch === stateEpoch() && owns();
    const workspace = place.workspace;
    const computer = place.host === "orgo" && ((req.resume as ComputerState | undefined)?.runner === "computer" || (!req.resume && computerToolOn()));
    const fullAccess = mac && (req.fullAccess ?? fullAccessOn());
    const folder = mac ? taskDir(sessionId) : undefined;
    const sockets = folder ? taskSockets(folder) : undefined;
    const b = bot(req.botId);
    const macApps = !!(mac && b && (req.macApps ?? (composioOn() && accountsOf(b).length > 0)));
    const macData = !!(mac && b && (req.macData ?? dataOn(b)));
    const macUi = !!(mac && fullAccess && (req.macUi ?? cuaDriverHere()));
    if (sessionId && !req.resume && current()) patchSession(sessionId, { taskState: undefined, runner: undefined, responseId: undefined, owed: undefined, agentSessionId: undefined, env: undefined });
    if (computer) {
      const opened: OpenThread = { id: sessionId || "computer", runner: "computer", ownerKey, ownerToken, place, instructions: req.instructions, seen: new Set() };
      if (sessionId && current()) patchSession(sessionId, { runner: "computer", agentSessionId: undefined, env: undefined });
      if (current()) req.opened?.(opened);
      return opened;
    }
    let thread = req.resume as OpenState | undefined;
    if (!thread) {
      let created: { id: string; environment: { id: string; remote_url: string } };
      try {
        created = (await client.beta.agents.sessions.create({
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
            { type: "mcp", server_label: mac ? "browser" : "screen", ...(mac && !fullAccess ? { allowed_tools: MAC_BROWSER_TOOLS } : {}), transport: mac ? browserMcp(place.cdpPort, folder) : {
              type: "stdio", command: "/opt/bops/venv/bin/python",
              args: ["/opt/bops/screen_mcp.py", "stdio", "--session", (place as Extract<TaskPlace, { host: "orgo" }>).sessionId, "--bot", (place as Extract<TaskPlace, { host: "orgo" }>).botId], cwd: "/workspace", env_vars: ["DISPLAY"],
            }, required: true },
            ...(macApps || macData ? [{ type: "mcp", server_label: "apps", transport: appsMcp(folder!, { apps: macApps, data: macData }), required: false }] : []),
            ...(macUi ? [{ type: "mcp", server_label: "mac", allowed_tools: MAC_UI_TOOLS, transport: macUiMcp(folder!), required: false }] : []),
          ],
          ...(mac ? {} : { multi_agent: { enabled: true, max_concurrent_subagents: 3 } }),
        },
        environment: { type: "self_hosted", workspace_directory: workspace, capability_directories: [`${workspace}/capabilities/skills`] },
        } as never, usageTags("session", req.botId))) as unknown as { id: string; environment: { id: string; remote_url: string } };
      } catch (e) {
        if (ownerKey && owns()) taskOwners.delete(ownerKey);
        throw e;
      }
      if (!current()) {
        if (ownerKey && owns()) taskOwners.delete(ownerKey);
        throw new Error("The signed-in account changed while the task was opening");
      }
      thread = { id: created.id, env: { id: created.environment.id, remoteUrl: created.environment.remote_url } };
    }
    const env = thread.env!;
    const pinnedEnv = mac ? { ...env, cdpPort: place.cdpPort, ...(place.display === undefined ? {} : { display: place.display }) } : env;
    const opened: OpenThread = { ...thread, env: pinnedEnv, ownerKey, ownerToken, place, instructions: req.instructions, fullAccess, macApps, macData, macUi, folder, seen: new Set() };
    if (!current()) throw new Error("The signed-in account changed while the task was opening");
    if (sessionId) patchSession(sessionId, { agentSessionId: thread.id, env: { id: env.id, remoteUrl: env.remoteUrl, workspace, ...(mac ? { cdpPort: place.cdpPort, ...(place.display === undefined ? {} : { display: place.display }), fullAccess, ...(sockets ? { sockets } : {}), ...(macApps ? { apps: true } : {}), ...(macData ? { data: true } : {}), ...(macUi ? { ui: "bops" as const } : {}) } : { display: place.display }) } });
    if (current()) req.opened?.(opened);
    try {
      if (mac) {
        if (!current()) throw new Error("The signed-in account changed while the task was opening");
        opened.executor = await startExecutor(sessionId, env.id, env.remoteUrl, place.cdpPort, folder, fullAccess);
        if (!current()) throw new Error("The signed-in account changed while the task was opening");
        if (macApps || macData) opened.closeApps = serveApps(sessionId, appsSocket(folder!));
      }
      else {
        await startOrgoExecutor(place.computerId, place.display, env, ownerToken);
        if (!current()) throw new Error("The signed-in account changed while the task was opening");
      }
    } catch (e) {
      await this.close(opened);
      throw e;
    }
    return opened;
  },
  async turn(req) {
    const thread = req.thread as OpenThread;
    if ("runner" in thread && thread.runner === "computer") return runComputerTurn(req, thread);
    await runTurn(req, thread.seen);
    return finalAnswer(thread.id);
  },
  async close(thread) {
    const opened = thread as OpenThread;
    const owns = ownsTask(opened);
    if (owns) opened.closeApps?.();
    if (opened.place.host === "mac") stopExecutor(opened.place.sessionId ?? "", opened.executor, opened.folder, owns);
    else if (!("runner" in opened && opened.runner === "computer")) {
      const { computerId, display } = opened.place;
      const id = (opened as OpenState).env?.id;
      const marker = `/root/.bops/executor-owner-${display}`;
      const key = `/root/.bops/executor-key-${display}`;
      const lock = `/root/.bops/executor-lock-${display}`;
      if (owns) {
        const release = [
          "set -e",
          `while ! mkdir '${lock}' 2>/dev/null; do sleep 0.05; done`,
          `trap 'rmdir "${lock}"' EXIT`,
          `if [ "$(cat '${marker}' 2>/dev/null)" = '${opened.ownerToken}' ]; then`,
          ...(id ? [`  pkill -f "[e]nvironment-id ${id}" || true`] : []),
          `  rm -f '${key}' '${marker}'`,
          "fi",
          `rmdir '${lock}'`,
          "trap - EXIT",
        ].join("\n");
        await orgo.bash(computerId, release, 15).catch(() => {});
      }
    }
    if (opened.ownerKey && owns && taskOwners.get(opened.ownerKey) === opened.ownerToken) taskOwners.delete(opened.ownerKey);
  },
};

async function runComputerTurn(req: TaskTurn, thread: OpenThread) {
  if (thread.place.host !== "orgo") throw new Error("The Responses computer runner is only available on an Orgo computer.");
  const b = bot(req.botId);
  const ac = new AbortController();
  req.hooks.bindStop(() => ac.abort());
  if (req.hooks.isStopped()) ac.abort();
  const staleCheck = setInterval(() => { if (req.hooks.isStopped()) ac.abort(); }, 200);
  try {
    return await computerTurn({
      sessionId: req.sessionId ?? thread.place.sessionId,
      computerId: thread.place.computerId,
      display: thread.place.display,
      model: taskModel(req.effort),
      effort: req.effort,
      instructions: thread.instructions,
      apps: !!(b && composioOn() && accountsOf(b).length > 0),
      input: req.input,
      signal: ac.signal,
      timeoutMs: TURN_MAX_MS,
      idleMs: TURN_IDLE_MS,
      epoch: req.epoch,
      isCurrent: () => req.hooks.isCurrent?.() ?? !req.hooks.isStopped(),
      step: req.hooks.step,
      steer: req.hooks.steer,
    });
  } catch (e) {
    if (req.hooks.isStopped()) throw new Error("Stopped by you");
    throw e;
  } finally {
    clearInterval(staleCheck);
  }
}

async function startOrgoExecutor(computerId: string, display: number, env: { id: string; remoteUrl: string }, ownerToken: string) {
  const key = Buffer.from(await executorKey()).toString("base64");
  const marker = `/root/.bops/executor-owner-${display}`;
  const keyPath = `/root/.bops/executor-key-${display}`;
  const lock = `/root/.bops/executor-lock-${display}`;
  const started = await orgo.bash(
    computerId,
    [
      "mkdir -p /root/.bops && chmod 700 /root/.bops",
      `while ! mkdir '${lock}' 2>/dev/null; do sleep 0.05; done`,
      `trap 'rmdir "${lock}"' EXIT`,
      `echo ${key} | base64 -d > '${keyPath}' && chmod 600 '${keyPath}'`,
      `printf '%s' '${ownerToken}' > '${marker}' && chmod 600 '${marker}'`,
      `rmdir '${lock}' && trap - EXIT`,
      `bops-exec ${display} '${env.id}' '${env.remoteUrl}'`,
    ].join("\n"),
    30,
  );
  if (started.exit_code !== 0) throw new Error(`executor failed: ${started.output.slice(0, 200)}`);
}

const sendMessage = (agentSessionId: string, text: string) =>
  client.beta.agents.sessions.events.create(agentSessionId, {
    events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] }],
  } as never);
const cancelTurn = (agentSessionId: string) =>
  client.beta.agents.sessions.events.create(agentSessionId, { events: [{ type: "agent.session.input.cancel" }] } as never).then(() => undefined, () => undefined);

async function runTurn(req: TaskTurn, seen: Set<string>) {
  const { input, hooks } = req;
  const sessionId = req.sessionId ?? "";
  const agentSessionId = req.thread.id;
  const stream = await client.beta.agents.sessions.events.stream(agentSessionId);
  if (hooks.isStopped()) {
    stream.controller.abort();
    throw new Error("Stopped by you");
  }
  hooks.bindStop(() => {
    void cancelTurn(agentSessionId);
    stream.controller.abort();
  });
  await sendMessage(agentSessionId, input);
  if (hooks.isStopped()) {
    await cancelTurn(agentSessionId);
    stream.controller.abort();
    throw new Error("Stopped by you");
  }

  const steering: Promise<boolean>[] = [];
  let lastSteered: ReturnType<NonNullable<TaskHooks["steer"]>> | undefined;
  let steeringBusy = false;
  const steer = () => {
    if (steeringBusy || lastSteered || hooks.isStopped()) return;
    const said = hooks.steer?.();
    if (!said || hooks.isStopped()) return;
    lastSteered = said;
    steeringBusy = true;
    steering.push(sendMessage(agentSessionId, said.text).then(
      () => {
        steeringBusy = false;
        if (hooks.isStopped()) {
          said.failed?.();
          if (lastSteered === said) lastSteered = undefined;
        }
        else said.sent();
        return true;
      },
      () => {
        steeringBusy = false;
        said.failed?.();
        if (lastSteered === said) lastSteered = undefined;
        return false;
      },
    ));
  };
  const landed = async () => (await Promise.all(steering.splice(0))).some(Boolean);
  const steeredOn = async () => {
    if (!(await landed())) return false;
    const now = await client.beta.agents.sessions.retrieve(agentSessionId).catch(() => undefined);
    if (hooks.isStopped()) return false;
    if (now?.status !== "in_progress" && now?.status !== "requires_action") return false;
    // The provider accepted the pending batch and has a follow-up turn queued.
    lastSteered = undefined;
    hooks.bindSteer?.(steer);
    steer();
    return true;
  };
  hooks.bindSteer?.(steer);
  steer();

  const poll = setInterval(() => void syncSteps(sessionId, agentSessionId, seen, hooks), 2500);
  const staleCheck = setInterval(() => {
    if (!hooks.isStopped()) return;
    void cancelTurn(agentSessionId);
    stream.controller.abort();
  }, 250);
  let gaveUp: string | undefined;
  const giveUp = (why: string) => { gaveUp = why; stream.controller.abort(); };
  let timeout = setTimeout(() => giveUp(TOO_LONG), TURN_MAX_MS);
  let idle = setTimeout(() => giveUp(STALLED), TURN_IDLE_MS);
  const progressed = () => { clearTimeout(idle); idle = setTimeout(() => giveUp(STALLED), TURN_IDLE_MS); };
  let failure: string | undefined = "The session ended without finishing";
  let creditStopped: string | undefined;
  let cancelledOut = false;
  let afterCancel: NodeJS.Timeout | undefined;
  const turnOwner = new Map<string, string | null>();
  let mainTurn: string | undefined;
  const s = session(sessionId);
  const model = taskModel(req.effort);
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
      turn?: { subagent_id?: string | null; error?: { code?: string; message?: string }; usage?: TokenCount };
      subagent?: { id: string; name: string | null };
      usage?: TokenCount;
    }>) {
      if (hooks.isStopped()) {
        failure = "Stopped by you";
        break;
      }
      if (event.type === "agent.session.turn.created" && event.turn_id) turnOwner.set(event.turn_id, event.turn?.subagent_id ?? null);
      if (event.type === "agent.session.turn.created" && event.turn_id && !event.turn?.subagent_id) mainTurn ??= event.turn_id;
      if (event.type === "agent.session.turn.created" && !event.turn?.subagent_id && afterCancel) {
        clearTimeout(afterCancel);
        afterCancel = undefined;
        clearTimeout(timeout);
        timeout = setTimeout(() => giveUp(TOO_LONG), TURN_MAX_MS);
      }
      if (event.type === "agent.session.turn.item.done" || event.type === "agent.session.turn.created") progressed();
      if (/^agent\.session\.turn\.(completed|failed|cancelled)$/.test(event.type) && event.turn_id) countTurn(event.turn_id, event.turn?.usage ?? event.usage);
      if (event.type === "agent.session.subagent.created" && event.subagent?.name) {
        const { id: helperId, name } = event.subagent;
        if (!hooks.isStopped()) {
          helperNameById.set(helperId, name);
          patchSession(sessionId, (x) => { if (!x.helperNames?.includes(name)) x.helperNames = [...(x.helperNames ?? []), name]; });
        }
      }
      if (event.type === "agent.session.turn.item.done" && event.item) {
        const sub = event.turn_id ? turnOwner.get(event.turn_id) : null;
        const who = sub ? helperNameById.get(sub) : undefined;
        if (!sub || who) {
          const changed = recordItem(sessionId, event.item, seen, hooks, who);
          if (changed) void syncHelperScreens(sessionId, hooks);
        }
      }
      const root = !event.turn?.subagent_id;
      if (event.type === "agent.session.turn.completed" && root) {
        hooks.bindSteer?.();
        if (await steeredOn()) {
          clearTimeout(timeout);
          timeout = setTimeout(() => giveUp(TOO_LONG), TURN_MAX_MS);
          progressed();
          continue;
        }
        // A successful POST accepted the reply. Keep it delivered when this turn is now idle;
        // only an explicit active_turn_not_steerable event rolls it back above.
        lastSteered = undefined;
        failure = undefined;
        break;
      }
      if (event.type === "agent.session.turn.failed" && root && event.turn?.error?.code === "active_turn_not_steerable" && mainTurn && event.turn_id !== mainTurn) {
        // Only the latest reply batch was refused; it remains undelivered for the next turn.
        lastSteered?.failed?.();
        lastSteered = undefined;
        continue;
      }
      if ((event.type === "agent.session.turn.failed" && root) || event.type === "agent.session.failed" || event.type === "agent.session.environment.failed") {
        failure = event.turn?.error?.message ?? event.type;
        const code = event.turn?.error?.code;
        if (code === AI_CREDIT_EMPTY || code === AI_CREDIT_LOW) creditStopped = code;
        break;
      }
      if (event.type === "agent.session.turn.cancelled" && root && !afterCancel)
        afterCancel = setTimeout(() => { cancelledOut = true; stream.controller.abort(); }, CANCELLED_WAIT_MS);
    }
  } catch (e) {
    const timedOut = !hooks.isStopped() && !cancelledOut && !!gaveUp && (e as Error).name === "AbortError";
    if (timedOut) void cancelTurn(agentSessionId);
    failure = hooks.isStopped() ? "Stopped by you" : cancelledOut ? "It was stopped before it finished" : timedOut ? gaveUp : (e as Error).message;
  } finally {
    hooks.bindSteer?.();
    clearInterval(poll);
    clearInterval(staleCheck);
    clearTimeout(timeout);
    clearTimeout(idle);
    clearTimeout(afterCancel);
    stream.controller.abort();
  }
  const late = await landed();
  if (late && failure) void cancelTurn(agentSessionId);
  for (const turnId of turnOwner.keys())
    if (!seen.has(`turn:${turnId}`)) {
      seen.add(`turn:${turnId}`);
      settleTurn(turnId, agentSessionId, model, s?.botId, epoch);
    }
  await syncSteps(sessionId, agentSessionId, seen, hooks);
  if (creditStopped === AI_CREDIT_EMPTY) throw outOfCreditError();
  if (creditStopped === AI_CREDIT_LOW) throw new CloudError(failure ?? "It needs more AI credit than you have left.", 402, AI_CREDIT_LOW);
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
  if (hooks.isStopped()) return false;
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
  if (hooks.isStopped()) return;
  try {
    const record = (item: Item, who?: string) => recordItem(sessionId, item, seen, hooks, who);

    const items: Item[] = [];
    for await (const item of client.beta.agents.sessions.items.list(agentSessionId) as AsyncIterable<Item>) items.push(item);
    if (hooks.isStopped()) return;
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
      if (hooks.isStopped()) return;
      helpers.reverse();
      for (const h of helpers) helperNameById.set(h.id, h.name);
      const names = helpers.map((h) => h.name);
      if (names.join() !== known.join() && !hooks.isStopped()) patchSession(sessionId, { helperNames: names });
      for (const h of helpers) {
        if (hooks.isStopped()) return;
        if (closedHelpers.has(h.id)) continue;
        const theirs: Item[] = [];
        for await (const item of client.beta.agents.sessions.subagents.items.list(h.id, { session_id: agentSessionId, order: "asc" }) as AsyncIterable<Item>)
          theirs.push(item);
        if (hooks.isStopped()) return;
        for (const item of theirs.filter((i) => !seen.has(i.id))) record(item, h.name);
        if (h.status !== "active") closedHelpers.add(h.id);
      }
    }
    if (ledgerChanged) await syncHelperScreens(sessionId, hooks);
  } catch {
    /* transient; the next poll catches up */
  }
}

/** Read which screens this thread's helpers hold from the computer's screen ledger. */
async function syncHelperScreens(sessionId: string, hooks?: TaskHooks) {
  if (hooks?.isStopped()) return;
  const s = session(sessionId);
  const b = s && bot(s.botId);
  const computerId = b && workComputer(b).computerId;
  if (!computerId) return;
  const out = await orgo.bash(computerId, "bops-screens list", 15);
  if (hooks?.isStopped()) return;
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

