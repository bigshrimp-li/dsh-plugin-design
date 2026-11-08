export async function configureModel(service,baseUrl,modelId,tools=["bash"]) {
  const credential=await service.settings.stageCredential({requestId:"stage",secret:"synthetic-loopback-only"});
  const current=await service.settings.getSettings();
  const modelConfiguration={schemaVersion:1,app:{name:"fixture",version:"1"},credentials:[{id:"fixture",kind:"api_key",source:{type:"credential_store",ref:credential.credentialRef}}],
    providers:[{id:"fixture",driver:"compatible",protocol:"openai-completions",baseUrl,allowLoopbackHttp:true,credentialRef:"fixture",authScheme:"bearer",protocolOptions:{maxTokensField:"max_tokens"}}],
    models:[{id:"fixture-model",providerRef:"fixture",modelId,definition:{source:"explicit",contextWindow:16384,maxOutputTokens:1024,capabilities:{input:["text"],tools:true,thinking:false,toolResultImages:"unsupported"}},
      generation:{maxOutputTokens:256,reasoning:{mode:"provider_default"}}}], requestPolicy:{totalTimeoutMs:10000,streamIdleTimeoutMs:5000,maxAttempts:1}};
  const op=await service.settings.applySettings({requestId:"configure",expectedVersion:current.version,configuration:{...current.configuration,modelConfiguration,defaultModelConfigId:"fixture-model",tools:{enabled:tools,approval:"approve_none"}}});
  const result=await service.settings.getOperation(op.operationId);
  if(result.status!=="succeeded")throw Error("Model settings did not activate: "+JSON.stringify(result));
}
