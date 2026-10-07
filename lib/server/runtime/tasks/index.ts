import "server-only";
import { runtimeFor, type RuntimeId } from "../config";
import { codexTasks } from "./codex";
import { openaiTasks } from "./openai";
import type { TasksRuntime } from "./types";

export type { TaskThread, TaskHooks } from "./types";
const TASKS: Record<RuntimeId, TasksRuntime> = { openai: openaiTasks, codex: codexTasks };

/** Existing threads keep their runtime when the environment changes. */
export function tasksRuntime(id: RuntimeId = runtimeFor("tasks")): TasksRuntime {
  return TASKS[id];
}
export const taskRuntimeId = () => runtimeFor("tasks");
export const tasksOutOfCredit = () => tasksRuntime().outOfCredit();

/** Native Mac apps always run on the ChatGPT plan, in both task runtimes. */
export const macTasksRuntime = (): TasksRuntime => TASKS.codex;
