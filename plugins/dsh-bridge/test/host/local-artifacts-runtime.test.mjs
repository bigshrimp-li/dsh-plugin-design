import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startGo,configureModel } from "./go-service.mjs";
import { createLocalArtifactService } from "../../src/host/local-artifacts.js";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("downloads actual published Run artifacts through the SDK and applies them on the DSH computer with durable per-file recovery", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "sa-local-runtime-"))); cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  const source = join(scratch, "execution-source"), destination = join(scratch, "dsh-local-destination"); await mkdir(source); await mkdir(destination);
  for (const root of [source, destination]) { await writeFile(join(root, "edit.md"), "base"); await writeFile(join(root, "delete.md"), "delete baseline"); }
  const server=await startGo(join(scratch,"server"),"real-dsh-host");cleanups.push(server.stop);
  const {sdk}=server;
  const upstream=createServer(async(req,res)=>{
    const chunks=[];for await (const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const finished=body.messages.some(message=>message.role==="tool");
    const command="printf 'actual changed result' > edit.md; printf 'actual new result' > new.md; rm delete.md";
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({id:"tool-response",model:"artifact-fixture",choices:[{index:0,message:{role:"assistant",content:finished?"complete":"",...(finished?{}:{tool_calls:[{id:"produce",type:"function",function:{name:"bash",arguments:JSON.stringify({command})}}]})},finish_reason:finished?"stop":"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));cleanups.push(async()=>{upstream.closeAllConnections();await new Promise(done=>upstream.close(done));});
  await configureModel(server,`http://127.0.0.1:${upstream.address().port}/v1`,"artifact-fixture");
  const workspace=await sdk.registerWorkspace({requestId:"workspace",root:source});
  const snapshot=await sdk.files.snapshotDirectory(workspace.workspaceId,{requestId:"input",path:source});
  const thread=await sdk.createThread({requestId:"create",agentId:"main",workspaceId:workspace.workspaceId,cwd:source,permissionMode:"approve_none",modelId:"artifact-fixture"});
  const run=await sdk.submitInput(thread.threadId,{requestId:"input-run",text:"Update the fixture files",conversationId:thread.mainConversationId,fileInput:{mode:"fixed_snapshot",snapshotId:snapshot.snapshotId}});
  let published = false;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const current = await sdk.getRun(run.runId);
    if (current.status === "failed" || current.status === "cancelled") throw Error("Run failed: " + JSON.stringify(current));
    if (current.status === "completed") {
      const files = await sdk.files.getRunFiles(run.runId);
      if (files.status === "succeeded" && files.resultSnapshotId) { published = true; break; }
    }
    await delay(30);
  }
  expect(published).toBe(true);
  const service = createLocalArtifactService({ files: sdk.files, home: join(scratch, "dsh-state"), actorId: "real-dsh-host" });
  const artifacts = await sdk.files.getArtifacts(run.runId); expect(artifacts.files.map(item => item.path)).toEqual(["delete.md", "edit.md", "new.md"]);
  // The remote Core cannot import or apply to this local destination. Only the host service can.
  await expect(sdk.files.applyArtifacts(run.runId, { requestId: "remote-cannot-write", destination, paths: ["new.md"] })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await writeFile(join(destination, "edit.md"), "local user change");
  const request = { requestId: "local-apply", runId: run.runId, destination, paths: artifacts.files.map(item => item.path) };
  const applied = await service.apply(request); expect(applied.items.map(item => item.status)).toEqual(["applied", "conflict", "applied"]);
  expect(await readFile(join(destination, "edit.md"), "utf8")).toBe("local user change"); expect(await readFile(join(destination, "new.md"), "utf8")).toBe("actual new result");
  await expect(readFile(join(destination, "delete.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(destination, "new.md"), "user changed after success"); await writeFile(join(destination, "edit.md"), "base");
  const reopened = createLocalArtifactService({ files: sdk.files, home: join(scratch, "dsh-state"), actorId: "real-dsh-host" });
  expect(await reopened.apply(request)).toEqual(applied);
  const retried = await reopened.apply({ ...request, requestId: "retry", retryOperationId: applied.operationId }); expect(retried.items.every(item => item.status === "applied")).toBe(true);
  expect(await readFile(join(destination, "new.md"), "utf8")).toBe("user changed after success"); expect(await readFile(join(destination, "edit.md"), "utf8")).toBe("actual changed result");
});
