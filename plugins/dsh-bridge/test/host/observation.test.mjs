import { describe, expect, it } from "vitest";

import {
  createObservationService,
  registerObservationRoutes,
} from "../../src/host/observation-service.js";

const BASE = "/super-agent/observation";

function fakeClient(overrides = {}) {
  const calls = [];
  const method = (name, result) => async (...args) => {
    calls.push({ name, args });
    const value = typeof result === "function" ? result(...args) : result;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    getObservationMetrics: method("getObservationMetrics", { metrics: [], asOf: "now", watermark: "w" }),
    getObservationTools: method("getObservationTools", { rows: [], asOf: "now", watermark: "w" }),
    getObservationUsage: method("getObservationUsage", { buckets: [], queryId: "u1", asOf: "now", watermark: "w" }),
    listObservationMembers: method("listObservationMembers", { members: [], queryId: "q1", side: "numerator", nextCursor: null }),
    getObservationHealth: method("getObservationHealth", { indexState: "ready" }),
    getObservationThreadGraph: method("getObservationThreadGraph", { threadId: "thr-1", nodes: [], edges: [] }),
    getObservationRunTrace: method("getObservationRunTrace", { runId: "run-1", facts: [], links: [] }),
    getObservationExecution: method("getObservationExecution", { executionId: "exec-1", attempts: [] }),
    getObservationContent: method("getObservationContent", (ref) => ({ status: "unknown", ref, content: null, reason: "not retained" })),
    ...overrides,
  };
}

function fakeWebServer() {
  const routes = new Map();
  return {
    routes,
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
}

function request({ method = "GET", headers = {}, body = "", url = "/" } = {}) {
  const chunks = body === "" ? [] : [Buffer.from(body, "utf8")];
  return {
    method,
    headers: { host: "127.0.0.1:3000", ...headers },
    url,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      if (body !== undefined) this.body += body;
    },
  };
}

function routesOver(service) {
  const webServer = fakeWebServer();
  const effect = (run) => {
    run();
    return () => {};
  };
  const paths = registerObservationRoutes({ webServer, effect, service, log: {} });
  return { webServer, paths };
}

const query = {
  from: "2026-10-01T00:00:00.000Z",
  until: "2026-10-21T00:00:00.000Z",
  scope: "all_runs",
  includeDescendants: "true",
  agentDefinitionVersion: "agent/v2",
  modelBinding: "provider/model with space",
  skillVersion: "review@3",
  permissionMode: "approve_none",
  runSource: "retry",
  deploymentVersion: "deploy-7",
  metric: ["tool.request_trigger_rate", "skill.context_rate"],
  groupBy: ["modelBinding", "skillVersion"],
};

describe("the host observation service", () => {
  it("forwards each observation read to its matching public SDK method", async () => {
    const client = fakeClient();
    const service = createObservationService({ client });
    const metricQuery = {
      window: { from: query.from, until: query.until, basis: "run_started_at" },
      scope: "all_runs",
      includeDescendants: true,
      filters: {
        agentDefinitionVersion: "agent/v2",
        modelBinding: "provider/model with space",
        toolVersion: null,
        skillVersion: "review@3",
        permissionMode: "approve_none",
        runSource: "retry",
        deploymentVersion: "deploy-7",
      },
      metrics: ["tool.request_trigger_rate", "skill.context_rate"],
      groupBy: ["modelBinding", "skillVersion"],
    };
    const usageQuery = { ...metricQuery, groupBy: "turn" };
    const memberQuery = { queryId: "q/1", side: "denominator", cursor: "next/1", limit: 20 };
    const ref = { kind: "entry", id: "entry/1", part: "output" };

    await service.metrics(metricQuery);
    await service.tools(metricQuery);
    await service.usage(usageQuery);
    await service.members(memberQuery);
    await service.health();
    await service.graph("thr/1");
    await service.trace("run/1");
    await service.execution("exec/1");
    await service.content(ref);

    expect(client.calls).toEqual([
      { name: "getObservationMetrics", args: [metricQuery] },
      { name: "getObservationTools", args: [metricQuery] },
      { name: "getObservationUsage", args: [usageQuery] },
      { name: "listObservationMembers", args: [memberQuery] },
      { name: "getObservationHealth", args: [] },
      { name: "getObservationThreadGraph", args: ["thr/1"] },
      { name: "getObservationRunTrace", args: ["run/1"] },
      { name: "getObservationExecution", args: ["exec/1"] },
      { name: "getObservationContent", args: [ref] },
    ]);
  });
});

describe("same-origin observation routes", () => {
  it("registers only fixed exact routes supported by the Harness host", () => {
    const { paths, webServer } = routesOver(createObservationService({ client: fakeClient() }));
    expect(paths).toEqual(expect.arrayContaining([
      `${BASE}/metrics`,
      `${BASE}/tools`,
      `${BASE}/usage`,
      `${BASE}/members`,
      `${BASE}/health`,
      `${BASE}/thread-graph`,
      `${BASE}/run-trace`,
      `${BASE}/conversation-trace`,
      `${BASE}/execution`,
      `${BASE}/content`,
    ]));
    expect(paths).toHaveLength(10);
    for (const path of paths) expect(webServer.routes.get(path).kind).toBe("exact");
  });

  it("passes full filter query values and repeated dimensions through without changing them", async () => {
    const calls = [];
    const service = {
      metrics: async (value) => (calls.push({ name: "metrics", value }), { metrics: [] }),
      tools: async (value) => (calls.push({ name: "tools", value }), { rows: [] }),
      usage: async (value) => (calls.push({ name: "usage", value }), { buckets: [] }),
    };
    const { webServer } = routesOver(service);

    const metricsResponse = response();
    await webServer.routes.get(`${BASE}/metrics`).handler(
      request({ url: `${BASE}/metrics?${new URLSearchParams([
        ["from", query.from],
        ["until", query.until],
        ["scope", query.scope],
        ["includeDescendants", query.includeDescendants],
        ["agentDefinitionVersion", query.agentDefinitionVersion],
        ["modelBinding", query.modelBinding],
        ["skillVersion", query.skillVersion],
        ["permissionMode", query.permissionMode],
        ["runSource", query.runSource],
        ["deploymentVersion", query.deploymentVersion],
        ["metric", query.metric[0]],
        ["metric", query.metric[1]],
        ["groupBy", query.groupBy[0]],
        ["groupBy", query.groupBy[1]],
      ])}` }),
      metricsResponse,
    );
    const usageResponse = response();
    await webServer.routes.get(`${BASE}/usage`).handler(
      request({ url: `${BASE}/usage?scope=entry_only&groupBy=turn&includeDescendants=false` }),
      usageResponse,
    );

    expect(calls).toEqual([
      {
        name: "metrics",
        value: {
          window: { from: query.from, until: query.until, basis: "run_started_at" },
          scope: "all_runs",
          includeDescendants: true,
          filters: {
            agentDefinitionVersion: "agent/v2",
            modelBinding: "provider/model with space",
            toolVersion: null,
            skillVersion: "review@3",
            permissionMode: "approve_none",
            runSource: "retry",
            deploymentVersion: "deploy-7",
          },
          metrics: ["tool.request_trigger_rate", "skill.context_rate"],
          groupBy: ["modelBinding", "skillVersion"],
        },
      },
      {
        name: "usage",
        value: {
          window: { from: null, until: null, basis: "run_started_at" },
          scope: "entry_only",
          includeDescendants: false,
          groupBy: "turn",
          filters: {
            agentDefinitionVersion: null,
            modelBinding: null,
            toolVersion: null,
            skillVersion: null,
            permissionMode: null,
            runSource: null,
            deploymentVersion: null,
          },
        },
      },
    ]);
    expect(metricsResponse.status).toBe(200);
    expect(usageResponse.status).toBe(200);
  });

  it("rejects invalid enum, duplicate scalar, and malformed content-ref inputs before calling the SDK", async () => {
    const calls = [];
    const service = {
      metrics: async (value) => (calls.push({ name: "metrics", value }), { metrics: [] }),
      content: async (value) => (calls.push({ name: "content", value }), { status: "unknown", ref: value }),
    };
    const { webServer } = routesOver(service);
    const extraField = Buffer.from(JSON.stringify({ kind: "entry", id: "entry/1", part: "output", path: "../../secret" }), "utf8").toString("base64url");
    const invalid = [
      [`${BASE}/metrics?scope=not-a-scope`, `${BASE}/metrics`],
      [`${BASE}/metrics?scope=entry_only&scope=all_runs`, `${BASE}/metrics`],
      [`${BASE}/content?ref=not_base64`, `${BASE}/content`],
      [`${BASE}/content?ref=${extraField}`, `${BASE}/content`],
    ];

    for (const [url, route] of invalid) {
      const res = response();
      await webServer.routes.get(route).handler(request({ url }), res);
      expect(res.status, url).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("routes fixed snapshot members and opaque business/content identifiers", async () => {
    const calls = [];
    const service = {
      members: async (value) => (calls.push({ name: "members", value }), { queryId: value.queryId, side: value.side, members: [], nextCursor: null }),
      graph: async (value) => (calls.push({ name: "graph", value }), { threadId: value }),
      trace: async (value) => (calls.push({ name: "trace", value }), { runId: value }),
      execution: async (value) => (calls.push({ name: "execution", value }), { executionId: value }),
      content: async (value) => (calls.push({ name: "content", value }), { status: "unknown", ref: value, content: null, reason: "missing" }),
    };
    const { webServer } = routesOver(service);
    const ref = { kind: "entry", id: "../credential/path?#", part: "output" };
    const encodedRef = Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");

    const requests = [
      [`${BASE}/members?queryId=q%2F1&side=denominator&cursor=c%2F2&limit=12`, `${BASE}/members`],
      [`${BASE}/thread-graph?threadId=thr%2Fone%3Fx%3D1`, `${BASE}/thread-graph`],
      [`${BASE}/run-trace?runId=run%2Fone%3Fx%3D1`, `${BASE}/run-trace`],
      [`${BASE}/execution?executionId=exec%2Fone%3Fx%3D1`, `${BASE}/execution`],
      [`${BASE}/content?ref=${encodedRef}`, `${BASE}/content`],
    ];
    for (const [url, route] of requests) {
      const res = response();
      await webServer.routes.get(route).handler(request({ url }), res);
      expect(res.status).toBe(200);
    }

    expect(calls).toEqual([
      { name: "members", value: { queryId: "q/1", side: "denominator", cursor: "c/2", limit: 12 } },
      { name: "graph", value: "thr/one?x=1" },
      { name: "trace", value: "run/one?x=1" },
      { name: "execution", value: "exec/one?x=1" },
      { name: "content", value: ref },
    ]);
  });

  it("rejects requests from an untrusted origin before reaching the service", async () => {
    let calls = 0;
    const { webServer } = routesOver({ health: async () => (calls += 1, { indexState: "ready" }) });
    const res = response();
    await webServer.routes.get(`${BASE}/health`).handler(
      request({ url: `${BASE}/health`, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
      res,
    );
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });
});
