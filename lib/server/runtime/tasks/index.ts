import "server-only";
import type { Session } from "@/lib/types";
import { runtimeFor, type RuntimeId } from "../config";
import { codexTasks } from "./codex";
import { openaiTasks } from "./openai";
import type { TasksRuntime } from "./types";

export type { TaskThread, TaskHooks } from "./types";
const TASKS: Partial<Record<RuntimeId, TasksRuntime>> = { openai: openaiTasks, codex: codexTasks };

/** Existing threads keep their runtime when the environment changes. */
export function tasksRuntime(id: RuntimeId = runtimeFor("tasks")): TasksRuntime {
  const runtime = TASKS[id];
  if (!runtime) throw new Error(`Runtime "${id}" does not support tasks. Use ${Object.keys(TASKS).map((id) => `BOPS_TASK_RUNTIME=${id}`).join(" or ")}.`);
  return runtime;
}
export function taskRuntimeId(session?: Session): RuntimeId {
  if (session?.taskRuntime) return session.taskRuntime;
  // Legacy sessions did not pin a runtime. Each provider recognizes its own persisted fields.
  if (session) for (const [id, runtime] of Object.entries(TASKS)) {
    if (runtime.resume({ ...session, taskState: undefined }) !== undefined) return id as RuntimeId;
  }
  return runtimeFor("tasks");
}
export const tasksOutOfCredit = () => tasksRuntime().outOfCredit();

/** Native Mac apps always run on the ChatGPT plan, in both task runtimes. */
export const macTasksRuntime = (): TasksRuntime => tasksRuntime("codex");
