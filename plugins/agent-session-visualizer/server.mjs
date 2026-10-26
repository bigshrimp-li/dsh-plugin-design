import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionContext as buildCodexContext, buildSessionGraph, codexDirectories, listSessions, refreshSessionIndex } from "./adapters/codex/index.mjs";
import { buildSessionContext as buildGrokContext, buildSessionGraph as buildGrokSessionGraph, grokDirectories, listSessions as listGrokSessions, refreshSessionIndex as refreshGrokSessionIndex } from "./adapters/grok/index.mjs";
import { buildSessionContext as buildClaudeContext, buildSessionGraph as buildClaudeSessionGraph, claudeDirectories, listSessions as listClaudeSessions, refreshSessionIndex as refreshClaudeSessionIndex } from "./adapters/claude/index.mjs";
import { buildSessionGraph as buildNovalSessionGraph, listSessions as listNovalSessions } from "./adapters/noval/index.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 3789);
const host = "127.0.0.1";
const providers = new Map([
  ["codex", { id: "codex", label: "Codex", directories: codexDirectories, listSessions, buildSessionGraph, buildSessionContext: buildCodexContext, refreshSessionIndex }],
  ["grok", { id: "grok", label: "Grok Build", directories: grokDirectories, listSessions: listGrokSessions, buildSessionGraph: buildGrokSessionGraph, buildSessionContext: buildGrokContext, refreshSessionIndex: refreshGrokSessionIndex }],
  ["claude", { id: "claude", label: "Claude Code", directories: claudeDirectories, listSessions: listClaudeSessions, buildSessionGraph: buildClaudeSessionGraph, buildSessionContext: buildClaudeContext, refreshSessionIndex: refreshClaudeSessionIndex }],
  ["noval", {
    id: "noval",
    label: "Noval",
    directories: () => [],
    listSessions: (opts) => listNovalSessions(opts),
    buildSessionGraph: (sessionId, opts) => buildNovalSessionGraph(sessionId, opts),
    refreshSessionIndex: async () => ({ provider: "noval", revision: 0, addedIds: [], changedIds: [], removedIds: [] })
  }],
]);
const eventClients = new Map([...providers.keys()].map((id) => [id, new Set()]));

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in ASV server:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection in ASV server:", err);
});

function safePath(pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(root, `.${decodeURIComponent(requested)}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

function sendJson(response, status, value) {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  let payload = "";
  try {
    payload = JSON.stringify(value);
  } catch (err) {
    if (!response.headersSent) {
      response.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      });
      response.end(JSON.stringify({ error: "SERIALIZATION_FAILED", message: err.message }));
    }
    return;
  }
  try {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    });
    response.end(payload);
  } catch (err) {
    console.error("Error writing response:", err);
  }
}

function broadcast(provider, event, value) {
  const body = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of eventClients.get(provider) || []) client.write(body);
}

setInterval(async () => {
  await Promise.all([...providers.values()].map(async (provider) => {
    try {
      const change = await provider.refreshSessionIndex();
      if (change.addedIds.length || change.changedIds.length || change.removedIds.length) broadcast(provider.id, "sessions-changed", change);
    } catch (error) {
      broadcast(provider.id, "index-error", { message: error.message });
    }
  }));
}, 2000).unref();

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
  if (request.url === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "public, max-age=86400" });
    response.end();
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, mode: "live-local", providers: [...providers.values()].map((provider) => ({ id: provider.id, label: provider.label, directories: provider.directories() })) });
    return;
  }
  if (url.pathname === "/api/providers") {
    sendJson(response, 200, { providers: [...providers.values()].map((provider) => ({ id: provider.id, label: provider.label, directories: provider.directories() })) });
    return;
  }
  const sessionsMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/sessions$/);
  if (sessionsMatch) {
    const provider = providers.get(decodeURIComponent(sessionsMatch[1]));
    if (!provider) { sendJson(response, 404, { error: "PROVIDER_NOT_FOUND" }); return; }
    try {
      const workspaceRoot = url.searchParams.get("workspaceRoot") || "";
      sendJson(response, 200, await provider.listSessions({ workspaceRoot }));
    } catch (error) {
      sendJson(response, 500, { error: "INDEX_FAILED", message: error.message });
    }
    return;
  }
  const eventsMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/events$/);
  if (eventsMatch) {
    const provider = providers.get(decodeURIComponent(eventsMatch[1]));
    if (!provider) { sendJson(response, 404, { error: "PROVIDER_NOT_FOUND" }); return; }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ provider: provider.id, at: new Date().toISOString() })}\n\n`);
    eventClients.get(provider.id).add(response);
    request.on("close", () => eventClients.get(provider.id).delete(response));
    return;
  }
  const contextMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/sessions\/([^/]+)\/context$/);
  if (contextMatch) {
    const provider = providers.get(decodeURIComponent(contextMatch[1]));
    if (!provider) { sendJson(response, 404, { error: "PROVIDER_NOT_FOUND" }); return; }
    if (!provider.buildSessionContext) {
      sendJson(response, 200, { provider: provider.id, contexts: [], note: "该 Provider 的会话日志没有持久化可变的输入上下文，只有消息与工具记录。" });
      return;
    }
    try {
      const sessionId = decodeURIComponent(contextMatch[2]);
      sendJson(response, 200, await provider.buildSessionContext(sessionId));
    } catch (error) {
      sendJson(response, error.code === "SESSION_NOT_FOUND" ? 404 : 500, { error: error.code || "CONTEXT_FAILED", message: error.message });
    }
    return;
  }
  const graphMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/sessions\/([^/]+)\/graph$/);
  if (graphMatch) {
    const provider = providers.get(decodeURIComponent(graphMatch[1]));
    if (!provider) { sendJson(response, 404, { error: "PROVIDER_NOT_FOUND" }); return; }
    try {
      const sessionId = decodeURIComponent(graphMatch[2]);
      const workspaceRoot = url.searchParams.get("workspaceRoot") || "";
      sendJson(response, 200, await provider.buildSessionGraph(sessionId, { workspaceRoot }));
    } catch (error) {
      sendJson(response, error.code === "SESSION_NOT_FOUND" ? 404 : 500, { error: error.code || "GRAPH_FAILED", message: error.message });
    }
    return;
  }

  if (url.pathname === "/api/summary" && request.method === "POST") {
    let bodyText = "";
    request.on("data", (chunk) => { bodyText += chunk; });
    request.on("end", async () => {
      try {
        const body = JSON.parse(bodyText || "{}");
        const type = body.type || "tools";
        const prompt = body.prompt || "";
        const systemPrompt = type === "agent"
          ? "你是一个系统行为审计助手。用极度精炼的一句话（严格限制在30个汉字以内）概括该Agent的核心职责与最终交付成果。不要前缀、不要寒暄、直接输出总结。"
          : "你是一个代码执行审计员。分析所给的工具命令与执行参数，用极度精炼的一句话（严格限制在25个汉字以内）说明这些工具执行了什么操作、读取或修改了什么核心文件。直接输出总结。";

        const magpieRes = await fetch("http://127.0.0.1:3425/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer magpie",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "opencode-go/deepseek-v4.1-flash",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
            max_tokens: 400,
          }),
        });

        if (!magpieRes.ok) {
          throw new Error(`Magpie response failed: ${magpieRes.status}`);
        }
        const data = await magpieRes.json();
        const msg = data?.choices?.[0]?.message;
        const summary = msg?.content?.trim() || msg?.reasoning_content?.trim()?.slice(0, 50) || "提炼完成。";
        sendJson(response, 200, { summary });
      } catch (err) {
        console.error("Summary error:", err);
        sendJson(response, 500, { error: "SUMMARY_FAILED", message: err.message, summary: "（智能提炼暂不可用）" });
      }
    });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    });
    response.end();
    return;
  }

  const path = safePath(url.pathname);
  if (!path) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      // CSP '*' excludes non-network schemes. DSH embeds this page from dsh-app://app.
      "content-security-policy": "default-src 'self' 'unsafe-inline' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https:; connect-src *; frame-ancestors 'self' dsh-app://app http://127.0.0.1:* http://localhost:*;",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function createAsvServer() {
  return http.createServer(handleRequest);
}

export async function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((res) => {
    const tester = http.createServer();
    tester.once("error", () => res(false));
    tester.once("listening", () => {
      tester.close(() => res(true));
    });
    tester.listen(port, host);
  });
}

export async function startServer(options = {}) {
  const chosenPort = Number(options.port || port);
  const chosenHost = options.host || host;

  // 探测现有端口是否已有 ASV 运行
  const available = await isPortAvailable(chosenPort, chosenHost);
  if (!available) {
    try {
      const probeRes = await fetch(`http://${chosenHost}:${chosenPort}/api/health`);
      if (probeRes.ok) {
        const data = await probeRes.json();
        if (data.ok && data.mode === "live-local") {
          return {
            server: null,
            port: chosenPort,
            host: chosenHost,
            reused: true,
            close: async () => {},
          };
        }
      }
    } catch (_) {}
  }

  const srv = createAsvServer();
  await new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(chosenPort, chosenHost, () => res());
  });

  return {
    server: srv,
    port: chosenPort,
    host: chosenHost,
    reused: false,
    close: async () => {
      await new Promise((res) => srv.close(() => res()));
    },
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  startServer({ port, host }).then((inst) => {
    console.log(`Agent Session Visualizer: http://${inst.host}:${inst.port} (reused: ${inst.reused})`);
  }).catch((err) => {
    console.error("Failed to start ASV server:", err);
  });
}
