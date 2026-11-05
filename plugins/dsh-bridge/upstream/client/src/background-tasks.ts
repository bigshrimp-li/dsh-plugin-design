import type { BackgroundOutputPage, BackgroundOutputQuery, BackgroundTaskPage, BackgroundTaskQuery, BackgroundTaskView,
  CommandReceipt, CreateScheduleRequest, ScheduleListQuery, SchedulePage, ScheduleView, TaskControlRequest } from "@super-agent/protocol";

type Request = <T extends object>(method: "GET" | "POST", path: string, body?: Record<string, unknown>) => Promise<T>;
function parameters(query: BackgroundTaskQuery | BackgroundOutputQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
const taskPath = (taskId: string) => `/v1/background-tasks/${encodeURIComponent(taskId)}`;
const schedulePath = (scheduleId: string) => `/v1/schedules/${encodeURIComponent(scheduleId)}`;

export function createBackgroundTaskClient(request: Request) {
  return {
    list: (conversationId: string, query: BackgroundTaskQuery = {}) =>
      request<BackgroundTaskPage>("GET", `/v1/conversations/${encodeURIComponent(conversationId)}/background-tasks${parameters(query)}`),
    listThread: (threadId: string, query: BackgroundTaskQuery = {}) =>
      request<BackgroundTaskPage>("GET", `/v1/threads/${encodeURIComponent(threadId)}/background-tasks${parameters(query)}`),
    get: (taskId: string) => request<BackgroundTaskView>("GET", taskPath(taskId)),
    output: (taskId: string, query: BackgroundOutputQuery) => request<BackgroundOutputPage>("GET", `${taskPath(taskId)}/output${parameters(query)}`),
    detach: (taskId: string, body: TaskControlRequest) => request<CommandReceipt>("POST", `${taskPath(taskId)}:detach`, body),
    cancel: (taskId: string, body: TaskControlRequest) => request<CommandReceipt>("POST", `${taskPath(taskId)}:cancel`, body),
  };
}
export type BackgroundTaskClient = ReturnType<typeof createBackgroundTaskClient>;

export function createScheduleClient(request: Request) {
  const collection = (conversationId: string) => `/v1/conversations/${encodeURIComponent(conversationId)}/schedules`;
  return {
    create: (conversationId: string, body: CreateScheduleRequest) => request<CommandReceipt>("POST", collection(conversationId), body),
    list: (conversationId: string, query: ScheduleListQuery = {}) => request<SchedulePage>("GET", collection(conversationId) + parameters(query)),
    get: (id: string) => request<ScheduleView>("GET", schedulePath(id)),
    pause: (id: string, body: TaskControlRequest) => request<CommandReceipt>("POST", `${schedulePath(id)}:pause`, body),
    resume: (id: string, body: TaskControlRequest) => request<CommandReceipt>("POST", `${schedulePath(id)}:resume`, body),
    cancel: (id: string, body: TaskControlRequest) => request<CommandReceipt>("POST", `${schedulePath(id)}:cancel`, body),
  };
}
export type ScheduleClient = ReturnType<typeof createScheduleClient>;
