import type { Host, Session } from "@/lib/types";

export type TaskEffort = "low" | "medium" | "high";
export type TaskPlace =
  | { host: "mac"; cdpPort: number; workspace: string }
  | { host: "orgo"; computerId: string; display: number; sessionId: string; botId: string; workspace: string };
export type TaskThread = { id: string };
export type TaskOpen = {
  instructions: string;
  effort: TaskEffort;
  place: TaskPlace;
  botId: string;
  resume?: unknown;
  opened?(thread: TaskThread): void;
  native?: boolean;
  apps?: { command: string; args: string[]; env: Record<string, string> };
};
export type TaskHooks = {
  step(tool: string, detail: string, by?: { who?: string; screen?: number }): void;
  removeLastNote?(text: string): void;
  caption(text: string): void;
  isStopped(): boolean;
  bindStop(stop: () => void): void;
  turnId?(id: string | undefined): void;
  /** Save a serializable continuation whenever it changes during a turn. */
  saveState?(state: unknown): void;
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
export type TaskSession = Pick<Session, "taskState" | "codexThread" | "taskTokens" | "agentSessionId" | "env">;
export type TasksRuntime = {
  /** Whether sessions must release their Orgo screen ledger claim. */
  releaseScreens: boolean;
  /** Read current continuation or this provider's legacy session fields. */
  resume(session: TaskSession): unknown;
  /** Only serializable continuation, never credentials or live executor handles. */
  snapshot(thread: TaskThread): unknown;
  assertHost(host: Host): void;
  outOfCredit(): Promise<boolean>;
  open(req: TaskOpen): Promise<TaskThread>;
  turn(req: TaskTurn): Promise<string>;
  close(thread: TaskThread): Promise<void>;
};

export const taskModel = (effort: TaskEffort) => effort === "high" ? process.env.BOPS_HARD_MODEL?.trim() || "gpt-6-astra" : process.env.BOPS_SESSION_MODEL?.trim() || "gpt-6.1-sol";
