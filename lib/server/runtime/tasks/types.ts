import type { Host, Session } from "@/lib/types";

export type TaskEffort = "low" | "medium" | "high";
export type TaskPlace =
  | { host: "mac"; cdpPort: number; display?: number; workspace: string; sessionId?: string; botId?: string }
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
  /** Mac browser-task capabilities; interpreted only by the OpenAI task runtime. */
  fullAccess?: boolean;
  macApps?: boolean;
  macData?: boolean;
  macUi?: boolean;
  sessionId?: string;
  /** State identity captured by the caller before setup begins; adapters use it to drop stale work. */
  epoch?: number;
};
export type TaskHooks = {
  step(tool: string, detail: string, by?: { who?: string; screen?: number }): void;
  removeLastNote?(text: string): void;
  caption(text: string): void;
  isStopped(): boolean;
  /** True while this run still owns its state, even after a user-requested stop. */
  isCurrent?(): boolean;
  bindStop(stop: () => void): void;
  bindSteer?(steer?: () => void): void;
  turnId?(id: string | undefined): void;
  /** Save a serializable continuation whenever it changes during a turn. */
  saveState?(state: unknown): void;
  computer?(apps: string[], target: { pid?: number; window_id?: number; bundle_id?: string; app?: string; name?: string }): void;
  /** Deliver any user replies that arrived while this turn was running. Mark sent after provider acceptance. */
  steer?(): { text: string; sent(): void; failed?(): void } | undefined;
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
export type TaskSession = Pick<Session, "taskState" | "codexThread" | "taskTokens" | "agentSessionId" | "env" | "runner" | "responseId" | "owed">;
/** Provider-owned continuation compatibility; sessions persists the result without decoding it. */
export type TaskResumeContext = {
  place: TaskPlace;
  sessionId?: string;
  lastDisplay?: number;
  fullAccess?: boolean;
  macApps?: boolean;
  macData?: boolean;
  macUi?: boolean;
};
export type TasksRuntime = {
  /** Whether sessions must release their Orgo screen ledger claim. */
  releaseScreens: boolean;
  /** Read current continuation or this provider's legacy session fields. */
  resume(session: TaskSession): unknown;
  /** Whether this provider can safely reuse its continuation in the requested place/configuration. */
  canResume?(session: TaskSession, context: TaskResumeContext): boolean;
  /** Only serializable continuation, never credentials or live executor handles. */
  snapshot(thread: TaskThread): unknown;
  assertHost(host: Host): void;
  outOfCredit(): Promise<boolean>;
  /** Whether a place/session will use the Responses computer tool, so orchestration can skip the browser MCP install. */
  usesComputerTool?(session: TaskSession, place: TaskPlace): boolean;
  /** Whether this turn ended on a provider-side user decision that must be answered before the next call. */
  waitForUser?(thread: TaskThread): boolean;
  open(req: TaskOpen): Promise<TaskThread>;
  turn(req: TaskTurn): Promise<string>;
  close(thread: TaskThread): Promise<void>;
};

export const taskModel = (effort: TaskEffort) => effort === "high" ? process.env.BOPS_HARD_MODEL?.trim() || "gpt-6-astra" : process.env.BOPS_SESSION_MODEL?.trim() || "gpt-6.1-sol";
