// Real Go process on an isolated UDS. Tests only use the public SDK.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, createSettingsClient } from "@super-agent/client";
export async function startGo(home,caller="authenticated-host",runtimeEnv={}) {
  const socketPath=join(home,"run","core.sock");
  const binary=process.env.SUPER_AGENT_GO_RUNTIME_BINARY || join(process.env.SUPER_AGENT_SOURCE_ROOT,"go-runtime","bin","super-agent-runtime");
  const child=spawn(binary,["serve","--home",home,"--socket",socketPath], {stdio:["ignore","ignore","pipe"],env:{...process.env,...runtimeEnv,HOME:home,CODEX_HOME:join(home,"codex")}});
  let diagnostic="", spawnError;
  child.on("error",error=>{spawnError=error;});
  child.stderr.setEncoding("utf8").on("data",chunk=>{diagnostic=(diagnostic+chunk).slice(-4096);});
  const options={socketPath,caller}, sdk=createClient(options);
  const stop=async()=>{
    if(!child.pid||child.exitCode!==null||child.signalCode)return;
    const done=once(child,"exit");child.kill("SIGTERM");const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
    try{await done;}finally{clearTimeout(timer);}
  };
  try{
    for(const deadline=Date.now()+20_000;Date.now()<deadline;){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null||child.signalCode)throw Error("Go Runtime exited: "+diagnostic);
      try{if((await sdk.getServerInfo()).state==="ready")return {sdk,settings:createSettingsClient(options),stop,options};}catch{}
      await delay(25);
    }
    throw Error("Go Runtime did not become ready: "+diagnostic);
  }catch(error){await stop();throw error;}
}
export { configureModel } from "./model-fixture.mjs";
