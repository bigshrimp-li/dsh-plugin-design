export type VerifyExecutionRequest = {
  readonly requestId: string;
  readonly conclusion: "succeeded" | "failed" | "not_executed" | "unresolved";
  readonly evidence: string;
};
export type ExecutionVerificationView = VerifyExecutionRequest & { readonly actorId: string; readonly at: number };
export type ExecutionView = {
  readonly ownerKind?: string;
  readonly goalId?: string;
  readonly assessmentId?: string;
  readonly requestRef?: string;
  readonly executionId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly intent: string;
  readonly arguments: Readonly<Record<string, unknown>> | null;
  readonly paramsHash: string;
  readonly status: string;
  readonly resultRef: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly verifications: readonly ExecutionVerificationView[];
};
