import type { CancelDelegationRequest, CancelDelegationResult, DelegationPageQuery, DelegationView, Page } from "@super-agent/protocol";

type Request = <T extends object>(method: "GET" | "POST", path: string, body?: Record<string, unknown>) => Promise<T>;
const pathFor = (id: string) => `/v1/delegations/${encodeURIComponent(id)}`;

export function createDelegationClient(request: Request) {
  return {
    list(conversationId: string, query: DelegationPageQuery = {}) {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      return request<Page<DelegationView>>("GET", `/v1/conversations/${encodeURIComponent(conversationId)}/delegations${params.size ? "?" + params : ""}`);
    },
    get: (id: string) => request<DelegationView>("GET", pathFor(id)),
    cancel: (id: string, body: CancelDelegationRequest) => request<CancelDelegationResult>("POST", pathFor(id) + ":cancel", body),
  };
}

export type DelegationClient = ReturnType<typeof createDelegationClient>;
