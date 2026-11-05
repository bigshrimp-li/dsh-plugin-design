import type { Page } from "./p1-contracts.js";

/** Tasks are durable resources, independent of the lifetime of a tool call. */
export type BackgroundTaskKind = "shell" | "delegation" | "monitor" | "schedule";
export type BackgroundTaskScope = { readonly threadId: string } | { readonly conversationId: string };
export type BackgroundTaskQuery = {
  readonly kind?: BackgroundTaskKind; readonly status?: string; readonly cursor?: string; readonly limit?: number;
};
export type BackgroundTaskView = {
  readonly taskId: string; readonly kind: BackgroundTaskKind; readonly threadId: string; readonly conversationId: string;
  readonly monitor?: { readonly sourceTaskId:string; readonly stream:"stdout"|"stderr"; readonly filter:string; readonly matches:number; readonly dropped:number; readonly partialLine:boolean; readonly offset:number; readonly status:string };
  readonly verification?:import("./executions.js").ExecutionVerificationView;
  readonly blockedByTaskId?:string; readonly waitReason?:string; readonly stdoutBytes?:number; readonly stderrBytes?:number;
  readonly nextAt?: number; readonly activeOccurrenceId?:string;
  readonly originRunId: string; readonly revision: number; readonly status: string; readonly deliveryState: string | null;
  readonly summary: string; readonly exitCode: number | null; readonly stopReason: string | null;
  readonly createdAt: number; readonly updatedAt: number; readonly startedAt: number | null; readonly endedAt: number | null;
  readonly allowedActions: readonly string[]; readonly executionId?: string; readonly childConversationId?: string;
  readonly childRunId?: string; readonly resultRef?: string | null; readonly truncated?: boolean;
};
/** Aggregate of all authorized matches at asOfSeq, independent of the page size. */
export interface BackgroundTaskObservation {
  readonly byKindAndStatus: Readonly<Partial<Record<BackgroundTaskKind, Readonly<Record<string, number>>>>>;
  readonly queueDepth: number;
  readonly terminalTasks: number;
  readonly unverifiedTasks: number;
  readonly oldestUnverifiedAt: number | null;
  readonly pendingDeliveries: number;
  readonly oldestPendingDeliveryAt: number | null;
  readonly maxHandleDelayMs: number | null;
  readonly maxTerminalDeliveryDelayMs: number | null;
  /** Confirmed output byte counts, independent of the artifact retention period. */
  readonly recordedOutputBytes: number;
  readonly maxTaskOutputBytes: number;
  readonly discardedOutputBytes: number;
  readonly monitorMergedLines: number;
  readonly monitorDroppedLines: number;
}
export type BackgroundTaskPage = Page<BackgroundTaskView> & {
  readonly asOfSeq: number;
  readonly observation: BackgroundTaskObservation;
};
export type TaskControlRequest = { readonly requestId: string; readonly expectedRevision?: number };
export type BackgroundOutputQuery = { readonly stream: "stdout" | "stderr"; readonly cursor?: string; readonly limitBytes?: number };
export type BackgroundOutputPage = {
  readonly exitCode:number|null; readonly data: string; readonly encoding: "utf8" | "base64"; readonly nextCursor: string; readonly eof: boolean;
  readonly truncated: boolean; readonly status: string; readonly offset: number; readonly nextOffset: number; readonly totalBytes: number;
};
export type CreateScheduleRequest = {
  readonly tools?: readonly ("read"|"ls"|"find"|"grep")[];
  readonly requestId: string; readonly prompt: string; readonly target: string; readonly stopCondition: string;
  readonly intervalSec: number; readonly expiresAt: number; readonly fireImmediately?: boolean; readonly dailyLimit?: number; readonly maxModelCalls?: number;
};
export type ScheduleView = {
  readonly scheduleId: string; readonly threadId: string; readonly conversationId: string; readonly status: string;
  readonly revision: number; readonly generation: number; readonly instruction: string; readonly target: string; readonly stopCondition: string;
  readonly intervalSeconds: number; readonly expiresAt: number; readonly nextAt: number; readonly activeOccurrenceId?: string;
  readonly tools:readonly string[];
  readonly occurrences?: readonly { readonly occurrenceId: string; readonly scheduledAt: number; readonly runId?: string; readonly conversationId?: string; readonly skipReason?: string; readonly result?: ScheduleReport }[];
  readonly lastResult?: ScheduleReport; readonly missedCount: number; readonly skipReason?: string; readonly dailyLimit: number; readonly maxModelCalls: number;
};
export type ScheduleListQuery = Pick<BackgroundTaskQuery, "cursor" | "limit">;
export type SchedulePage = Page<ScheduleView> & { readonly asOfSeq: number };
export type ScheduleReport = { readonly outcome: "continue" | "done" | "blocked"; readonly summary: string; readonly evidenceRefs: readonly string[] };
