/** The URL fragment scopes messages to the native Harness pane, never to canvas code. */
export function install(editor) {
  const params=new URLSearchParams(location.hash.slice(1));
  const sessionId=params.get('session'),channel=params.get('channel'),hostOrigin=params.get('hostOrigin');
  const available=window.parent!==window && !!sessionId && !!channel && !!hostOrigin && hostOrigin!=='null' && (hostOrigin==='dsh-app://app' || /^https?:\/\/[^/]+$/.test(hostOrigin));
  const pending=new Map();
  editor.hostSession=sessionId || 'standalone';
  function request(action,extra={}) {
    if(!available) return Promise.reject(new Error('请在 Harness 设计稿插件内插入草稿；当前可复制标注'));
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Harness 未响应；标注仍保留，可重试或复制'));},5000);
      pending.set(requestId,{resolve,reject,timer});
      window.parent.postMessage({type:'dsh-design:composer',sessionId,channel,requestId,action,...extra},hostOrigin);
    });
  }
  window.addEventListener('message',event=>{
    const data=event.data;
    if(event.source!==window.parent || event.origin!==hostOrigin || data?.type!=='dsh-design:composer-result' || data.sessionId!==sessionId || data.channel!==channel)return;
    const entry=pending.get(data.requestId);if(!entry)return;
    clearTimeout(entry.timer);pending.delete(data.requestId);
    if(data.ok)entry.resolve(data);else entry.reject(new Error(data.error || '草稿插入失败'));
  });
  window.addEventListener('pagehide',()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('会话已关闭'));}pending.clear();});
  editor.features.composer={capture:()=>request('capture'),insert:(token,text)=>request('insert',{token,text}),available};
}
