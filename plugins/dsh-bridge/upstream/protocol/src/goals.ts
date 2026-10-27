import type { CommandReceipt, Page, SubmitInputRequest } from "./p1-contracts.js";

/** A durable objective spanning multiple Runs. Token categories match model usage. */
export type GoalStatus = "running" | "waiting" | "pausing" | "paused" | "draining" | "blocked" | "exhausted" | "completed" | "cancelled" | "failed";
export type GoalPhase = "execute" | "assess" | "verify" | "idle";
export type GoalAcceptanceCriterion = { readonly id: string; readonly description: string };
export type GoalLimits = {
  readonly totalTokens: number;
  readonly maxIterations?: number;
  readonly maxModelRequests?: number;
  readonly maxActiveDurationMs?: number;
  readonly deadlineAt?: number;
  readonly assessmentReserveTokens?: number;
  readonly assessmentReserveRequests?: number;
};
export type GoalInput = Pick<SubmitInputRequest, "requiredFiles" | "materials" | "preparedAttachments" | "selectedSkillIds" | "selectedSkillRefs" | "previewId" | "previewSignature" | "fileInput" | "fileBranchId">;
export type CreateGoalRequest = GoalInput & {
  readonly requestId: string;
  readonly objective: string;
  readonly acceptanceCriteria?: readonly GoalAcceptanceCriterion[];
  readonly limits: GoalLimits;
  readonly resumePolicy?: "manual_after_restart";
};
export type GoalControlRequest = { readonly requestId: string; readonly expectedRevision: number; readonly reason?: string };
export type SteerGoalRequest = GoalControlRequest & { readonly text: string };
export type UpdateGoalRequest = GoalControlRequest & {
  readonly objective?: string;
  readonly acceptanceCriteria?: readonly GoalAcceptanceCriterion[];
  readonly limits?: Partial<GoalLimits>;
};
export type GoalReceipt = CommandReceipt & { readonly goalId: string; readonly revision: number };
export type GoalBudgetView = {
  readonly settledTokens: number; readonly reservedTokens: number; readonly uncertainTokens: number;
  /** Subset of settledTokens charged at a conservative bound when provider usage is absent. */
  readonly estimatedTokens?: number;
  readonly modelRequests: number; readonly activeElapsedMs: number; readonly ledgerRevision?: number;
};
export type GoalCheckpoint = {
  readonly summary: string; readonly completedItems: readonly string[]; readonly remainingItems: readonly string[];
  readonly nextStep: string; readonly evidenceRefs: readonly string[];
  readonly blockerKey?: string; readonly progressFingerprint?: string; readonly repeatedBlockers?: number; readonly repeatedGaps?: number;
};
export type GoalView = {
  readonly goalId: string; readonly threadId: string; readonly conversationId: string;
  readonly objective: string; readonly acceptanceCriteria: readonly GoalAcceptanceCriterion[];
  readonly revision: number; readonly specVersion: number; readonly controlEpoch: number; readonly evidenceRevision: number;
  readonly desiredState: "running" | "paused" | "cancelled"; readonly status: GoalStatus; readonly phase: GoalPhase;
  readonly reason: string | null; readonly currentRunId: string | null; readonly iteration: number;
  readonly limits: GoalLimits; readonly budget: GoalBudgetView; readonly checkpoint?: GoalCheckpoint;
  readonly resumePolicy: "manual_after_restart"; readonly createdAt: number; readonly updatedAt: number;
  /** Watermark read atomically with this view, used to resume the committed SSE stream. */
  readonly eventSeq: number;
};
export type GoalPage = Page<GoalView> & { readonly eventSeq: number };
export type GoalListQuery = { readonly cursor?: string; readonly limit?: number };
