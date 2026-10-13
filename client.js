/** Session-scoped adapter for the public Harness draft API. Never submits a message. */
function setupComposerBridge({ frame, sessionId, url, channel, inputActions, targetWindow = window }) {
  const origin = new URL(url).origin;
  const captures = new Map();
  const receive = event => {
    const data = event.data;
    if (event.source !== frame.current?.contentWindow || event.origin !== origin || !data ||
        data.type !== 'dsh-design:composer' || data.sessionId !== sessionId || data.channel !== channel ||
        typeof data.requestId !== 'string' || data.requestId.length > 100) return;
    const reply = result => event.source.postMessage({ type:'dsh-design:composer-result', requestId:data.requestId, sessionId, channel, ...result }, origin);
    try {
      if (!inputActions?.captureInsertion || !inputActions?.insertText) throw new Error('当前 Harness 没有提供草稿接口，请复制标注后手动粘贴');
      if (data.action === 'capture') {
        const span = inputActions.captureInsertion();
        if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) throw new Error('草稿暂时不可编辑，请稍后重试');
        const token = crypto.randomUUID();
        captures.set(token, { span:{...span,start:span.end}, at:Date.now() });
        while(captures.size>10) captures.delete(captures.keys().next().value);
        reply({ok:true,token});
      } else if (data.action === 'insert') {
        const entry = captures.get(data.token); captures.delete(data.token);
        if (!entry || Date.now()-entry.at>30000) throw new Error('插入位置已失效，请重新点击插入草稿');
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length>200000) throw new Error('标注内容为空或过长');
        if (!inputActions.insertText(data.text,entry.span)) throw new Error('草稿已变化或暂时不可编辑，请重试；标注仍保留');
        reply({ok:true});
      } else reply({ok:false,error:'不支持的草稿操作'});
    } catch(error) { reply({ok:false,error:error.message || '草稿插入失败'}); }
  };
  targetWindow.addEventListener('message',receive);
  return () => { captures.clear(); targetWindow.removeEventListener('message',receive); };
}

window.__ModuleLoader__.load({
	id: '@local/dsh-plugin-design',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		function DesignEditor({ sessionId, useSessions, inputActions }) {
			const frame = React.useRef(null);
			const channel = React.useRef(null);
			if (!channel.current) channel.current = crypto.randomUUID();
			const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd);
			const [attempt, retry] = React.useState(0);
			const [state, setState] = React.useState({});
			React.useEffect(() => {
				const controller = new AbortController();
				setState({});
				const base = new URL(document.baseURI);
				base.search = ''; base.hash = '';
				if (!base.pathname.endsWith('/')) base.pathname += '/';
				const endpoint = new URL('design-editor/open', base);
				endpoint.searchParams.set('sessionId', sessionId);
				fetch(endpoint, { method: 'POST', signal: controller.signal })
					.then(async response => {
						const value = await response.json();
						if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
						if (!controller.signal.aborted) setState({ ...value, sessionId, cwd });
					})
					.catch(error => {
						if (!controller.signal.aborted) setState({ error: error.message, sessionId, cwd });
					});
				return () => controller.abort();
			}, [sessionId, cwd, attempt]);
			// A session change must never briefly display the previous workspace.
			const current = state.sessionId === sessionId && state.cwd === cwd ? state : {};
			React.useEffect(() => {
				if (!current.url) return;
				return setupComposerBridge({frame,sessionId,url:current.url,channel:channel.current,inputActions});
			}, [sessionId,cwd,current.url,inputActions]);
			if (!current.url) return h('div', { role: 'status', style: { padding: 20 } },
				h('p', null, current.error || '正在连接当前工作区…'),
				current.error && h('button', { type: 'button', onClick: () => retry(value => value + 1) }, '重新连接'));
			const editorURL = new URL(current.url);
			editorURL.hash = new URLSearchParams({session:sessionId,channel:channel.current,hostOrigin:window.location.origin}).toString();
			return h('iframe', {
				key: sessionId + ':' + current.url,
				ref: frame,
				src: editorURL.href,
				title: '设计稿编辑器',
				style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' },
			});
		}

		return {
			inject: ['slots', 'sidebarRightTabs'],
			apply(ctx) {
				// rightbar.session 是宿主独占槽位；插件只能注册其中的标签页。
				const id = '@local/dsh-plugin-design/editor';
				ctx.effect(() => ctx.sidebarRightTabs.register({
					id,
					kind: 'design-editor',
					title: () => '设计稿编辑器',
					guide: [{
						id: 'design-editor',
						order: 50,
						title: () => '设计稿编辑器',
						description: () => '直接编辑当前会话工作区中的设计稿',
					}],
				}));
				ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
					ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, DesignEditor),
				));
			},
		};
	},
});
