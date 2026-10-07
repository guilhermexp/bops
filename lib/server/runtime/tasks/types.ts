import type { Host } from "@/lib/types";

export type TaskEffort = "low" | "medium" | "high";
export type TaskPlace =
  | { host: "mac"; cdpPort: number; workspace: string }
  | { host: "orgo"; computerId: string; display: number; sessionId: string; botId: string; workspace: string };
export type TaskThread = { id: string; tokens?: { input: number; output: number }; env?: { id: string; remoteUrl: string } };
export type TaskOpen = {
  instructions: string;
  effort: TaskEffort;
  place: TaskPlace;
  botId: string;
  resume?: TaskThread;
  opened?(thread: TaskThread): void;
  native?: boolean;
  apps?: { command: string; args: string[]; env: Record<string, string> };
};
export type TaskHooks = {
  step(tool: string, detail: string, by?: { who?: string; screen?: number }): void;
  caption(text: string): void;
  isStopped(): boolean;
  bindStop(stop: () => void): void;
  turnId?(id: string | undefined): void;
  tokens?(total: { input: number; output: number }): void;
  computer?(apps: string[], target: { pid?: number; window_id?: number; bundle_id?: string; app?: string; name?: string }): void;
};
export type TaskTurn = {
  thread: TaskThread;
  input: string;
  effort: TaskEffort;
  botId: string;
  epoch: number;
  sessionId?: string;
  hooks: TaskHooks;
};
export type TasksRuntime = {
  assertHost(host: Host): void;
  outOfCredit(): Promise<boolean>;
  open(req: TaskOpen): Promise<TaskThread>;
  turn(req: TaskTurn): Promise<string>;
  close(thread: TaskThread): Promise<void>;
};

export const taskModel = (effort: TaskEffort) => effort === "high" ? process.env.BOPS_HARD_MODEL?.trim() || "gpt-6-astra" : process.env.BOPS_SESSION_MODEL?.trim() || "gpt-6.1-sol";
