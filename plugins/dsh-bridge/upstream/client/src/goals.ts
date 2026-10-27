import type { CreateGoalRequest, GoalControlRequest, GoalListQuery, GoalPage, GoalReceipt, GoalView, SteerGoalRequest, UpdateGoalRequest } from "@super-agent/protocol";

export type GoalRequester = <T extends object>(method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>) => Promise<T>;
export function createGoalClient(request: GoalRequester) {
  const encode = encodeURIComponent;
  const write = (method: "POST" | "PATCH", path: string, body: object) => request<GoalReceipt>(method, path, body as Record<string, unknown>);
  return {
    create: (conversationId: string, body: CreateGoalRequest) => write("POST", `/v1/conversations/${encode(conversationId)}/goals`, body),
    list: (conversationId: string, query: GoalListQuery = {}) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      return request<GoalPage>("GET", `/v1/conversations/${encode(conversationId)}/goals${params.size ? `?${params}` : ""}`);
    },
    get: (goalId: string) => request<GoalView>("GET", `/v1/goals/${encode(goalId)}`),
    update: (goalId: string, body: UpdateGoalRequest) => write("PATCH", `/v1/goals/${encode(goalId)}`, body),
    steer: (goalId: string, body: SteerGoalRequest) => write("POST", `/v1/goals/${encode(goalId)}:steer`, body),
    pause: (goalId: string, body: GoalControlRequest) => write("POST", `/v1/goals/${encode(goalId)}:pause`, body),
    resume: (goalId: string, body: GoalControlRequest) => write("POST", `/v1/goals/${encode(goalId)}:resume`, body),
    cancel: (goalId: string, body: GoalControlRequest) => write("POST", `/v1/goals/${encode(goalId)}:cancel`, body),
  };
}
export type GoalClient = ReturnType<typeof createGoalClient>;
