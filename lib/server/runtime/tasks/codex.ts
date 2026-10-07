import "server-only";
import { mkdirSync } from "node:fs";
import { codex } from "../../codex";
import { browserServer } from "../../local";
import { recordTokens } from "../../usage";
import { codexAuth, CodexSignInError, type CodexAuth } from "../codex/auth";
import { CodexLimitError } from "../codex/client";
import { taskModel, type TaskOpen, type TaskThread, type TaskTurn, type TasksRuntime } from "./types";

const TURN_TIMEOUT_MS = 10 * 60_000;
type CodexThread = TaskThread & { auth: CodexAuth; native?: boolean };
type Problem = { message?: string; code?: string | number; codexErrorInfo?: string | Record<string, unknown>; resets_at?: number; resets_in_seconds?: number };

function failure(error: Problem, auth: CodexAuth): Error {
  const info = JSON.stringify(error.codexErrorInfo ?? error.code ?? "");
  const message = error.message ?? "Codex couldn't finish";
  if (/usage_limit_reached|rate_limit_exceeded|usageLimitExceeded|usage limit|rate limit/i.test(`${info} ${message}`)) {
    const reset = error.resets_at ? error.resets_at * 1000 : error.resets_in_seconds ? Date.now() + error.resets_in_seconds * 1000 : undefined;
    return new CodexLimitError(reset, auth.plan);
  }
  if (/unauthorized|not authenticated|sign.?in|authentication|401/i.test(`${info} ${message}`)) return new CodexSignInError();
  return new Error(message);
}

async function settings(req: TaskOpen) {
  // Bops supplies the task's instructions and tools. Personal coding skills and MCPs must not
  // send a bot browser task into the user's own browser or apps.
  const [read, listed] = await Promise.all([
    codex.request<{ config?: { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown> } }>("config/read", { cwd: req.place.workspace }),
    codex.request<{ data?: { skills: { path: string; pluginId?: string | null }[] }[] }>("skills/list", { cwds: [req.place.workspace] }),
  ]);
  const personalSkills = listed.data?.flatMap((entry) => entry.skills).filter((skill) => !req.native || !skill.pluginId?.includes("computer-use")) ?? [];
  const isolated = req.native ? {} : {
    mcp_servers: Object.fromEntries(Object.keys(read.config?.mcp_servers ?? {}).map((name) => [name, { enabled: false }])),
    plugins: Object.fromEntries(Object.keys(read.config?.plugins ?? {}).map((name) => [name, { enabled: false }])),
  };
  const config = req.native
    ? req.apps ? { mcp_servers: { bops_apps: { ...req.apps, tool_timeout_sec: 1200 } } } : undefined
    : { ...isolated, web_search: "live", mcp_servers: { ...isolated.mcp_servers, browser: browserServer(req.place.host === "mac" ? req.place.cdpPort : 0, req.place.workspace) } };
  return {
    model: taskModel(req.effort), cwd: req.place.workspace,
    approvalPolicy: req.native ? "on-request" : "never",
    ...(req.native ? { approvalsReviewer: "user" } : {}),
    sandbox: req.native ? "read-only" : "workspace-write",
    developerInstructions: req.instructions,
    config: { project_doc_max_bytes: 0, skills: { config: personalSkills.map((skill) => ({ path: skill.path, enabled: false })) }, ...config },
  };
}

export const codexTasks: TasksRuntime = {
  assertHost(host) {
    if (host === "orgo") throw new Error("Codex tasks work on this Mac only. Use BOPS_TASK_RUNTIME=openai for an Orgo computer.");
  },
  async outOfCredit() { return false; },
  async open(req) {
    this.assertHost(req.place.host);
    const auth = await codexAuth();
    mkdirSync(req.place.workspace, { recursive: true });
    await codex.ready();
    try {
      const result = req.resume
        ? await codex.request<{ thread: { id: string } }>("thread/resume", { threadId: req.resume.id, ...await settings(req) })
        : await codex.request<{ thread: { id: string } }>("thread/start", { ...await settings(req), serviceName: "Bops" });
      const thread: CodexThread = { id: result.thread.id, auth, native: req.native, tokens: req.resume ? req.resume.tokens : { input: 0, output: 0 } };
      req.opened?.(thread);
      return thread;
    } catch (e) {
      throw failure(e as Problem, auth);
    }
  },
  turn(req) { return turn(req); },
  async close(thread) {
    codex.off(thread.id);
    // Release the loaded thread and its tool processes; resume reloads the saved history/config.
    await codex.request("thread/unsubscribe", { threadId: thread.id }).catch(() => {});
  },
};

function turn({ thread, input, effort, botId, epoch, hooks }: TaskTurn): Promise<string> {
  const { auth, native } = thread as CodexThread;
  return new Promise((resolve, reject) => {
    let last = "";
    let turnId: string | undefined;
    let ended = false;
    let stopRequested = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let countedTotal = false;
    const seen = new Set<string>();
    const summaries = new Map<string, string>();
    const model = taskModel(effort);
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      codex.off(thread.id);
      hooks.turnId?.(undefined);
      if (usage && !countedTotal) recordTokens("session", model, { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, botId, epoch);
      if (error) reject(error);
      else resolve(last || "Done.");
    };
    const interrupt = () => {
      stopRequested = true;
      if (turnId && !stopTimer) {
        stopTimer = setTimeout(() => finish(new Error("Stopped by you")), 10_000);
        void codex.request("turn/interrupt", { threadId: thread.id, turnId }).catch((e: Error) => finish(e));
      }
    };
    const timer = setTimeout(() => { interrupt(); finish(new Error("Codex took too long on this step")); }, TURN_TIMEOUT_MS);
    hooks.bindStop(interrupt);
    codex.on(thread.id, (m) => {
      if (ended) return;
      const p = m.params as {
        turnId?: string; itemId?: string; delta?: string; willRetry?: boolean; error?: Problem;
        tokenUsage?: { last?: { inputTokens: number; outputTokens: number }; total?: { inputTokens: number; outputTokens: number } };
        item?: { id?: string; type?: string; text?: string; phase?: string; server?: string; tool?: string; command?: string | string[]; arguments?: Record<string, unknown>; action?: { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string } };
        turn?: { id?: string; status?: string; error?: Problem };
      };
      if (turnId && p.turnId && p.turnId !== turnId) return;
      const item = p.item;
      if (m.method === "thread/tokenUsage/updated") {
        usage = p.tokenUsage?.last ?? usage;
        const total = p.tokenUsage?.total;
        if (total) {
          // Total spans all model requests, including tool loops. A resumed old thread without a
          // saved baseline starts at the last request; new threads start at zero.
          const before = thread.tokens ?? { input: total.inputTokens - (usage?.inputTokens ?? 0), output: total.outputTokens - (usage?.outputTokens ?? 0) };
          const input = Math.max(0, total.inputTokens - before.input);
          const output = Math.max(0, total.outputTokens - before.output);
          if (input || output) recordTokens("session", model, { input_tokens: input, output_tokens: output }, botId, epoch);
          countedTotal = true;
          thread.tokens = { input: total.inputTokens, output: total.outputTokens };
          hooks.tokens?.(thread.tokens);
        }
      }
      else if (m.method === "item/reasoning/summaryTextDelta") {
        const key = p.itemId ?? "reasoning";
        const text = (summaries.get(key) ?? "") + (p.delta ?? "");
        summaries.set(key, text);
        const line = text.replace(/\*\*/g, "").split(/(?<=[.!?])\s/)[0].trim();
        if (line) hooks.caption(line.charAt(0).toLowerCase() + line.slice(1, 60).replace(/[.!?]$/, ""));
      } else if ((m.method === "item/started" || m.method === "item/completed") && item) {
        const key = item.id ?? `${item.type}:${item.tool ?? item.command ?? item.text}`;
        if (item.type === "agentMessage" && m.method === "item/completed") {
          if (item.text) {
            last = item.text;
            if (item.phase === "commentary" && !seen.has(key)) {
              hooks.step("note", item.text);
              if (!summaries.size) hooks.caption(item.text.replace(/\*\*/g, "").trim().slice(0, 60));
            }
          }
          seen.add(key);
        } else if (!seen.has(key)) {
          const args = item.arguments ?? {};
          if (item.type === "mcpToolCall") {
            seen.add(key);
            if (native) {
              const apps = [...String(args.code ?? "").matchAll(/getApp\(\s*["'`]([^"'`]+)["'`]/g)].map((x) => /^[a-z]+(\.[\w-]+){2,}$/i.test(x[1]) ? x[1].split(".").at(-1)! : x[1]);
              hooks.computer?.(apps, args);
            }
            if (!summaries.size) hooks.caption(typeof args.title === "string" ? args.title.slice(0, 60) : item.tool === "browser_navigate" ? "opening the page" : "using the browser");
            hooks.step(item.server === "cua_repl" ? "computer" : item.tool ?? "tool", typeof args.title === "string" ? args.title : describe(item.tool, args));
          } else if (item.type === "commandExecution") {
            seen.add(key);
            if (!summaries.size) hooks.caption("running a command");
            hooks.step("command", `ran ${Array.isArray(item.command) ? item.command.join(" ") : item.command ?? "a command"}`.slice(0, 120));
          } else if (item.type === "webSearch" && m.method === "item/completed") {
            seen.add(key);
            if (!summaries.size) hooks.caption("searching the web");
            const a = item.action;
            const q = a?.query ?? a?.queries?.join(", ");
            hooks.step("search", a?.type === "openPage" || a?.type === "open_page" ? `read ${a.url}` : q ? `searched "${q.slice(0, 70)}"` : "searched the web");
          }
        }
      } else if (m.method === "turn/completed") {
        if (turnId && p.turn?.id && p.turn.id !== turnId) return;
        finish(p.turn?.status === "failed" ? failure(p.turn.error ?? {}, auth) : p.turn?.status === "interrupted" || stopRequested || hooks.isStopped() ? new Error("Stopped by you") : undefined);
      } else if (m.method === "error" && !p.willRetry) finish(failure(p.error ?? {}, auth));
    });
    codex.request<{ turn: { id: string } }>("turn/start", {
      threadId: thread.id, input: [{ type: "text", text: input }], model, effort, summary: "auto",
    }).then((r) => {
      turnId = r.turn.id;
      if (ended) {
        if (stopRequested || hooks.isStopped()) void codex.request("turn/interrupt", { threadId: thread.id, turnId }).catch(() => {});
        return;
      }
      hooks.turnId?.(turnId);
      if (stopRequested || hooks.isStopped()) interrupt();
    }).catch((e) => finish(failure(e as Problem, auth)));
  });
}

function describe(tool: string | undefined, args: Record<string, unknown>) {
  if (tool === "browser_navigate") return `opened ${args.url}`;
  if (tool === "browser_snapshot") return "read the page";
  if (tool === "browser_click") return `clicked ${args.element ?? args.ref}`;
  if (tool === "browser_type") return `typed "${String(args.text).slice(0, 60)}"`;
  if (tool === "browser_take_screenshot") return "looked at the screen";
  if (tool === "browser_wait_for") return "waited for the page";
  if (tool === "browser_press_key") return `pressed ${args.key}`;
  return `used ${tool ?? "a tool"}`;
}
