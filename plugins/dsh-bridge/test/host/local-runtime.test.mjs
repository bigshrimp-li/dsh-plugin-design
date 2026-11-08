import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { LocalRuntime } from "../../src/host/local-runtime.js";
import { localService } from "../../src/host/local-service.js";

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "go:dsh-"));
  const options = { home, socketPath: join(home, "run/core.sock") };
  await mkdir(dirname(options.socketPath), { recursive: true });
  cleanups.push(() => rm(home,{recursive:true,force:true}));
  let info = { home, socketPath: options.socketPath, runtimeKind:"go", instanceId:"test-i1",
    protocol:{min:1,max:1}, state:"ready", pid:123, startedAt:"2026-11-01T00:00:00Z", runtimeFeatures:{eventsWebSocketV1:true} };
  const requests = [];
  const http = createServer((req,res) => {
    requests.push(new URL(req.url,"http://local"));
    res.setHeader("content-type","application/json");
    if(req.url.startsWith("/v1/events/snapshot")) res.end(JSON.stringify({ instanceId:info.instanceId, eventSeq:7, threads:[] }));
    else if(req.url === "/v1/server") res.end(JSON.stringify(info));
    else res.end(JSON.stringify({}));
  });
  const ws = new WebSocketServer({server:http});
  ws.on("connection",(_socket,req)=>{ requests.push(new URL(req.url,"http://local")); });
  const listen = async () => { http.listen(options.socketPath); await once(http,"listening"); };
  const start = vi.fn(async () => { await listen(); return {ended:false}; });
  const runtime = new LocalRuntime(options,{startProcess:start, readyTimeoutMs:750});
  cleanups.push(async () => {
    runtime.close();
    for(const client of ws.clients)client.terminate();
    await new Promise(done=>ws.close(done));
    if(http.listening)await new Promise(done=>http.close(done));
  });
  return { runtime,ws,listen,start,home,requests,info,http };
}

it("discovers/starts once across concurrent plugin calls and attaches the WS on startup",async()=>{
  const f=await fixture();
  const opened=once(f.ws,"connection");
  f.runtime.start();
  const infos=await Promise.all([f.runtime.ensure(),f.runtime.ensure()]);
  expect(infos.map(x=>x.pid)).toEqual([123,123]);
  await opened;
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.requests.find(x=>x.pathname==="/v1/events/ws")?.searchParams.get("after")).toBe("7");
  const listen=localService(f.runtime);
  const target=await listen.call("targets.list");
  expect(target.selectedId).toBe("local-go:test-i1");
  f.info.instanceId="replacement";
  await expect(listen.call("thread.create",{targetId:target.selectedId})).rejects.toMatchObject({code:"VERSION_CONFLICT"});
});

it("reuses a compatible owner and never launches over an incompatible listener",async()=>{
  const f=await fixture(); await f.listen();
  expect((await f.runtime.ensure()).pid).toBe(123);
  f.info.runtimeKind="ts";
  await expect(f.runtime.ensure()).rejects.toMatchObject({code:"PROTOCOL_MISMATCH"});
  expect(f.start).not.toHaveBeenCalled();
});

it("keeps each workspace subscription on its snapshot cursor and stops making launch attempts after a recorded shutdown",async()=>{
  const f=await fixture(); await f.listen();
  const ac=new AbortController(); const service=localService(f.runtime);
  const subscribed=service.subscribe({workspaceId:"ws-B",signal:ac.signal});
  const opened=once(f.ws,"connection"); const pending=subscribed.next();
  const [socket,request]=await opened;
  expect(new URL(request.url,"http://local").searchParams.get("workspaceId")).toBe("ws-B");
  socket.send(JSON.stringify({kind:"resync_required",code:"CURSOR_EXPIRED"}));
  expect((await pending).value).toMatchObject({kind:"resync_required"});
  await subscribed.return(); ac.abort();
  await writeFile(join(f.home,"run/stop-generation"),"1");
  f.http.closeAllConnections();
  await new Promise(done => f.http.close(done));
  await expect(f.runtime.ensure()).rejects.toMatchObject({code:"SERVER_STOPPING"});
  expect(f.start).not.toHaveBeenCalled();
});
