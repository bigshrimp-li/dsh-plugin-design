/**
 * Public, dependency-free observation DTOs and vocabulary.
 *
 * These types freeze what Core, the SDK, and Observe exchange. They describe
 * expected data; the server still has to collect real durable facts and expose
 * the routes before the capability is available.
 */
import type { JsonObject } from "./json.js";

export const OBSERVATION_FACT_TYPES = [
  "goal",
  "thread",
  "conversation",
  "run",
  "model_attempt",
  "tool_invocation",
  "skill_evidence",
  "delegation",
  "report",
] as const;

export type ObservationFactType = (typeof OBSERVATION_FACT_TYPES)[number];

export function isObservationFactType(value: string): value is ObservationFactType {
  return (OBSERVATION_FACT_TYPES as readonly string[]).includes(value);
}

export const OBSERVATION_SOURCE_KINDS = [
  "pi_conversation",
  "pi_entry",
  "pi_task",
  "pi_submission",
  "pi_document",
  "core_document",
  "behavior_record",
] as const;

export type ObservationSourceKind = (typeof OBSERVATION_SOURCE_KINDS)[number];

export const OBSERVATION_COVERAGE_STATES = ["complete", "partial", "unknown", "unsupported"] as const;

export type ObservationCoverageState = (typeof OBSERVATION_COVERAGE_STATES)[number];

export type ObservationCoverage = {
  readonly state: ObservationCoverageState;
  readonly missingFields: readonly string[];
  readonly reason: string | null;
};

export type ObservationContentRef = {
  /** Selects an allowlisted durable record family, never a filesystem path. */
  readonly kind: "entry" | "document" | "artifact";
  /** Exact opaque ID issued by the selected durable source. */
  readonly id: string;
  readonly part: "input" | "output" | "snapshot" | "artifact";
};

export const OBSERVATION_CONTENT_STATES = ["available", "unknown", "unsupported", "forbidden", "expired"] as const;

export type ObservationContentState = (typeof OBSERVATION_CONTENT_STATES)[number];

export type ObservationTraceId = string & { readonly __observationTraceId: unique symbol };

const OBSERVATION_TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/;

export function isObservationTraceId(value: string): value is ObservationTraceId {
  return OBSERVATION_TRACE_ID_PATTERN.test(value);
}

export type ObservationFactBase = {
  readonly goalId?: string | null;
  readonly goalIteration?: number | null;
  readonly factId: string;
  readonly sourceKind: ObservationSourceKind;
  readonly sourceRef: string;
  /** Opaque revision local to `sourceKind`/`sourceRef`; not a global clock. */
  readonly sourceRevision: string;
  readonly schemaVersion: number;
  readonly deploymentId: string;
  readonly storagePartitionId: string;
  readonly projectionVersion: number;
  readonly occurredAt: string | null;
  readonly threadId: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly traceId: ObservationTraceId | null;
  readonly turnId: string | null;
  readonly originRunId: string | null;
  readonly parentRunId: string | null;
  readonly requestRef: string | null;
  readonly attemptId: string | null;
  readonly toolCallId: string | null;
  readonly executionId: string | null;
  readonly delegationId: string | null;
  readonly deliveryId: string | null;
  readonly contentRefs: readonly ObservationContentRef[];
  readonly coverage: ObservationCoverage;
  readonly missingFields: readonly string[];
};

export type ThreadObservationFact = ObservationFactBase & {
  readonly type: "thread";
  readonly payload: {
    readonly status: string | null;
    readonly agentDefinitionVersion: string | null;
    readonly modelBinding: string | null;
    readonly permissionMode: string | null;
    readonly runSource: string | null;
    readonly deploymentVersion: string | null;
  };
};

export type ConversationObservationFact = ObservationFactBase & {
  readonly type: "conversation";
  readonly payload: {
    readonly purpose: "entry" | "subagent" | "report_followup" | "compaction" | "unknown";
    readonly forkedFromConversationId: string | null;
  };
};

export type RunObservationFact = ObservationFactBase & {
  readonly type: "run";
  readonly payload: {
    readonly status: string | null;
    readonly source: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly endReason: string | null;
    readonly entryRun: boolean | null;
  };
};

export type ObservationToolExposure = {
  readonly name: string;
  readonly version: string | null;
  readonly scope: "model" | "nested";
};

export type ObservationSkillExposure = {
  readonly skillId: string;
  readonly version: string | null;
};

export type ObservationUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costKnown: boolean;
  readonly cost: number | null;
  readonly currency: string | null;
  readonly unknownReason: string | null;
};

export type ModelAttemptObservationFact = ObservationFactBase & {
  readonly type: "model_attempt";
  readonly payload: {
    readonly purpose?: "agent" | "compaction" | "evaluate" | "verify" | "unknown";
    readonly compactionId?: string | null;
    readonly status: "requested" | "started" | "complete" | "failed" | "cancelled" | "unknown";
    readonly providerId: string | null;
    readonly modelId: string | null;
    readonly startedAt: string | null;
    readonly firstTokenAt: string | null;
    readonly durationMs?: number | null;
    readonly firstTokenLatencyMs?: number | null;
    readonly endedAt: string | null;
    readonly responseComplete: boolean | null;
    readonly exposedTools: readonly ObservationToolExposure[];
    readonly exposedSkills: readonly ObservationSkillExposure[];
    readonly usage: ObservationUsage | null;
  };
};

export const TOOL_INVOCATION_PHASES = ["requested", "accepted", "started", "terminal"] as const;

export type ToolInvocationPhase = (typeof TOOL_INVOCATION_PHASES)[number];

export const TOOL_INVOCATION_STATUSES = [
  "requested",
  "accepted",
  "started",
  "succeeded",
  "failed",
  "denied",
  "cancelled_before_start",
  "cancelled",
  "timed_out",
  "unknown",
] as const;

export type ToolInvocationStatus = (typeof TOOL_INVOCATION_STATUSES)[number];

export type ToolInvocationObservationFact = ObservationFactBase & {
  readonly type: "tool_invocation";
  readonly payload: {
    readonly phase: ToolInvocationPhase;
    readonly status: ToolInvocationStatus;
    readonly toolName: string;
    readonly caller: "model" | "code_mode" | "hook" | "unknown";
    readonly logicalInvocationId: string;
    readonly parentExecutionId: string | null;
    readonly responseFactId: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly durationMs: number | null;
  };
};

export const SKILL_EVIDENCE_PHASES = [
  "exposed",
  "read_complete",
  "in_context",
  "inherited",
  "summary_only",
  "unclassified",
] as const;

export type SkillEvidencePhase = (typeof SKILL_EVIDENCE_PHASES)[number];

export type SkillEvidenceObservationFact = ObservationFactBase & {
  readonly type: "skill_evidence";
  readonly payload: {
    readonly phase: SkillEvidencePhase;
    readonly skillId: string;
    readonly version: string | null;
    readonly contentHash: string | null;
    readonly source: "direct" | "inherited" | "summary" | "unknown";
    readonly requestRef: string | null;
    readonly coveredBytes: number | null;
    readonly expectedBytes: number | null;
  };
};

export type DelegationObservationFact = ObservationFactBase & {
  readonly type: "delegation";
  readonly payload: {
    readonly phase: "requested" | "accepted" | "started" | "terminal";
    readonly status: "requested" | "accepted" | "started" | "completed" | "failed" | "cancelled" | "unknown";
    readonly mode: "sync" | "async" | "unknown";
    readonly parentToolCallId: string | null;
    readonly childConversationId: string | null;
    readonly childRunId: string | null;
    readonly reportId: string | null;
  };
};

export const REPORT_STATUSES = [
  "generated",
  "pending",
  "incorporated",
  "processed",
  "suppressed",
  "failed_pending",
  "unknown",
] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type ReportObservationFact = ObservationFactBase & {
  readonly type: "report";
  readonly payload: {
    readonly status: ReportStatus;
    readonly reportId: string;
    readonly originalParentRunId: string | null;
    readonly recipientRunId: string | null;
    readonly generatedAt: string | null;
    readonly receivedAt: string | null;
    readonly processedAt: string | null;
  };
};

export type GoalObservationFact = ObservationFactBase & {
  readonly type: "goal";
  readonly payload: {
    readonly goalId: string; readonly status: string | null; readonly phase: string | null;
    readonly objective: string | null; readonly reason: string | null; readonly revision: number | null;
    readonly iteration: number | null; readonly settledTokens: number | null;
    readonly reservedTokens: number | null; readonly uncertainTokens: number | null;
    readonly totalTokens: number | null;
    readonly estimatedTokens?: number | null;
  };
};

export type ObservationFact =
  | GoalObservationFact
  | ThreadObservationFact
  | ConversationObservationFact
  | RunObservationFact
  | ModelAttemptObservationFact
  | ToolInvocationObservationFact
  | SkillEvidenceObservationFact
  | DelegationObservationFact
  | ReportObservationFact;

export type ReadObservationFactsRequest = {
  readonly cursor?: string | null;
  readonly limit: number;
};

export type ReadObservationFactsPage = {
  readonly facts: readonly ObservationFact[];
  readonly nextCursor: string | null;
  readonly watermark: string | null;
  readonly coverage: ObservationCoverage;
};

export type ObservationSourceCoverage = ObservationCoverage & {
  readonly byFactType: readonly {
    readonly type: ObservationFactType;
    readonly state: ObservationCoverageState;
    readonly count: number | null;
  }[];
};

export type ObservationContentResult =
  | {
      readonly status: "available";
      readonly ref: ObservationContentRef;
      readonly content: string;
      readonly contentType: "text/plain" | "application/json";
      readonly redactions: readonly string[];
      readonly reason: null;
    }
  | {
      readonly status: "unknown" | "unsupported" | "forbidden" | "expired";
      readonly ref: ObservationContentRef;
      readonly content: null;
      readonly contentType: null;
      readonly redactions: readonly [];
      readonly reason: string;
    };

/** Read-only source port owned by the Core Storage owner. */
export interface ObservationSource {
  readFacts(request: ReadObservationFactsRequest): Promise<ReadObservationFactsPage>;
  readContent(ref: ObservationContentRef): Promise<ObservationContentResult>;
  describeCoverage(): Promise<ObservationSourceCoverage>;
  /** A notification only; the index repairs missed changes by rescanning. */
  watchChanges(listener: () => void): () => void;
}

export const OBSERVATION_SCOPES = ["entry_only", "subagent_only", "all_runs"] as const;

export type ObservationScope = (typeof OBSERVATION_SCOPES)[number];

export const OBSERVATION_MEMBER_TYPES = ["run", "tool_invocation", "delegation", "report"] as const;

export type ObservationMemberType = (typeof OBSERVATION_MEMBER_TYPES)[number];

export const OBSERVATION_METRIC_NAMES = [
  "tool.request_trigger_rate",
  "tool.execution_trigger_rate",
  "tool.execution_success_rate",
  "skill.read_rate",
  "skill.context_rate",
  "subagent.request_trigger_rate",
  "subagent.start_rate",
  "subagent.sync_share",
  "subagent.async_share",
  "report.async_processing_rate",
] as const;

export type ObservationMetricName = (typeof OBSERVATION_METRIC_NAMES)[number];

export const OBSERVATION_FILTER_DIMENSIONS = [
  "agentDefinitionVersion",
  "modelBinding",
  "toolVersion",
  "skillVersion",
  "permissionMode",
  "runSource",
  "deploymentVersion",
] as const;

export type ObservationFilterDimension = (typeof OBSERVATION_FILTER_DIMENSIONS)[number];

export type ObservationWindow = {
  readonly from: string | null;
  readonly until: string | null;
  readonly basis: "run_started_at";
};

export type ObservationFilters = {
  readonly agentDefinitionVersion: string | null;
  readonly modelBinding: string | null;
  readonly toolVersion: string | null;
  readonly skillVersion: string | null;
  readonly permissionMode: string | null;
  readonly runSource: string | null;
  readonly deploymentVersion: string | null;
};

export type ObservationQuery = {
  readonly window: ObservationWindow;
  readonly scope: ObservationScope;
  readonly includeDescendants: boolean;
  readonly filters: ObservationFilters;
  readonly metrics: readonly ObservationMetricName[];
  readonly groupBy: readonly ObservationFilterDimension[];
};

export type ObservationMetricReason = "zero_denominator" | "missing_evidence" | "unsupported" | null;

export type ObservationMetricSnapshot = {
  readonly queryId: string;
  readonly metric: ObservationMetricName;
  readonly metricVersion: string;
  readonly memberType: ObservationMemberType;
  readonly window: ObservationWindow;
  readonly scope: ObservationScope;
  readonly includeDescendants: boolean;
  readonly filters: ObservationFilters;
  /** Metric-specific grouping key, for example `{ toolName: "edit" }`. */
  readonly group: Readonly<Record<string, string | null>>;
  readonly asOf: string;
  readonly watermark: string | null;
  readonly provisional: boolean;
  readonly coverage: ObservationCoverage;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly value: number | null;
  readonly unknownCount: number;
  readonly runningCount: number;
  readonly reason: ObservationMetricReason;
};

export type ObservationMetricsResponse = {
  readonly asOf: string;
  readonly watermark: string | null;
  readonly metrics: readonly ObservationMetricSnapshot[];
};

export type ObservationMetricMember = {
  readonly memberType: ObservationMemberType;
  readonly memberId: string;
  readonly runId: string | null;
  readonly sourceRefs: readonly string[];
};

export type ObservationMetricSide = "numerator" | "denominator";

export type ObservationMetricMembersRequest = {
  readonly queryId: string;
  readonly side: ObservationMetricSide;
  readonly cursor?: string | null;
  readonly limit?: number;
};

export type ObservationMetricMembersPage = {
  readonly queryId: string;
  readonly side: ObservationMetricSide;
  readonly memberType: ObservationMemberType;
  readonly members: readonly ObservationMetricMember[];
  readonly nextCursor: string | null;
};

export type ObservationToolOutcomeCounts = {
  readonly succeeded: number;
  readonly failed: number;
  readonly denied: number;
  readonly cancelledBeforeStart: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly unknown: number;
  readonly running: number;
};

export type ObservationToolMetricRow = {
  readonly toolName: string;
  readonly exposedRuns: number | null;
  readonly logicalInvocationCount: number | null;
  readonly attemptCount: number | null;
  readonly outcomes: ObservationToolOutcomeCounts;
  readonly requestTrigger: ObservationMetricSnapshot;
  readonly executionTrigger: ObservationMetricSnapshot;
  readonly executionSuccess: ObservationMetricSnapshot;
  readonly executionDurationMs: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly coverage: ObservationCoverage;
  };
};

export type ObservationToolsResponse = {
  readonly asOf: string;
  readonly watermark: string | null;
  readonly rows: readonly ObservationToolMetricRow[];
};

export type ObservationUsageQuery = {
  readonly window: ObservationWindow;
  readonly scope: ObservationScope;
  readonly includeDescendants: boolean;
  readonly groupBy: "run" | "turn" | "model";
  readonly filters: ObservationFilters;
};

export type ObservationUsageBucket = {
  readonly purpose?: "agent" | "compaction" | "evaluate" | "verify" | "unknown";
  readonly runId: string | null;
  readonly turnId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly unknownAttempts: number;
  readonly costKnown: boolean;
  readonly cost: number | null;
  readonly currency: string | null;
};

export type ObservationUsageResponse = {
  readonly queryId: string;
  readonly asOf: string;
  readonly watermark: string | null;
  readonly query: ObservationUsageQuery;
  readonly coverage: ObservationCoverage;
  readonly buckets: readonly ObservationUsageBucket[];
};

export type ObservationGraphNode = {
  readonly kind: "goal" | "conversation" | "run";
  readonly id: string;
  readonly threadId: string;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
};

export type ObservationGraphEdge = {
  readonly kind: "goal_iteration" | "parent_run" | "origin_run" | "delegation" | "report_delivery" | "fork";
  readonly fromId: string;
  readonly toId: string;
  readonly factId: string;
};

export type ObservationThreadGraph = {
  readonly threadId: string;
  readonly nodes: readonly ObservationGraphNode[];
  readonly edges: readonly ObservationGraphEdge[];
  readonly coverage: ObservationCoverage;
  readonly asOf: string;
  readonly watermark: string | null;
};

export type ObservationTraceLink = {
  readonly kind: "parent_run" | "delegation" | "report_delivery";
  readonly runId: string;
  readonly traceId: ObservationTraceId;
  readonly relationId: string;
};

export type ObservationRunTrace = {
  readonly runId: string;
  readonly traceId: ObservationTraceId;
  readonly threadId: string;
  readonly conversationId: string;
  readonly run: RunObservationFact | null;
  readonly facts: readonly ObservationFact[];
  readonly links: readonly ObservationTraceLink[];
  readonly coverage: ObservationCoverage;
  readonly asOf: string;
  readonly watermark: string | null;
};

/** A cursor retains a frozen projection, including revisions, across reconnects. */
export type ObservationConversationTraceQuery = {
  readonly cursor?: string | null;
  readonly search?: string;
  readonly limit?: number;
};
export type ObservationConversationTracePage = {
  readonly queryId: string;
  readonly conversationId: string;
  readonly search: string;
  readonly facts: readonly ObservationFact[];
  readonly offset: number;
  readonly total: number;
  readonly nextCursor: string | null;
  readonly asOf: string;
  readonly watermark: string | null;
  readonly coverage: ObservationCoverage;
};

export type ObservationExecutionAttempt = {
  readonly attemptId: string;
  readonly status: ToolInvocationStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly inputRef: ObservationContentRef | null;
  readonly outputRef: ObservationContentRef | null;
};

export type ObservationExecution = {
  readonly executionId: string;
  readonly logicalInvocationId: string;
  readonly runId: string | null;
  readonly toolName: string;
  readonly caller: "model" | "code_mode" | "hook" | "unknown";
  readonly status: ToolInvocationStatus;
  readonly parentExecutionId: string | null;
  readonly attempts: readonly ObservationExecutionAttempt[];
  readonly coverage: ObservationCoverage;
  readonly asOf: string;
  readonly watermark: string | null;
};

export type ObservationHealth = {
  readonly indexState: "ready" | "dirty" | "rebuilding" | "unavailable";
  readonly dirty: boolean;
  readonly watermark: string | null;
  readonly indexedFacts: number;
  readonly unindexedFacts: number;
  readonly droppedNotifications: number;
  readonly refreshCount: number;
  readonly rebuildCount: number;
  readonly missingExposureRuns: number;
  readonly missingTimeFacts: number;
  readonly unknownUsageAttempts: number;
  readonly sourceCoverage: ObservationSourceCoverage;
  readonly remoteExport: {
    readonly state: "disabled" | "pending" | "failed";
    readonly backlog: number;
  };
};

export type ObservationApiError = {
  readonly code: "CURSOR_EXPIRED" | "PERMISSION_DENIED" | "NOT_FOUND" | "NOT_SUPPORTED";
  readonly reason: string;
};

export const OBSERVATION_ROUTES = {
  metrics: "/v1/metrics",
  tools: "/v1/metrics/tools",
  usage: "/v1/metrics/usage",
  members: "/v1/metrics/{queryId}/members",
  health: "/v1/observation/health",
  threadGraph: "/v1/observation/threads/{threadId}/graph",
  runTrace: "/v1/observation/runs/{runId}/trace",
  conversationTrace: "/v1/observation/conversations/{conversationId}/trace",
  execution: "/v1/observation/executions/{executionId}",
  content: "/v1/observation/content/{ref}",
} as const;

/** JSON-compatible value helper for callers validating arbitrary payloads. */
export type ObservationJson = JsonObject;
