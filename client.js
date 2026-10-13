window.__ModuleLoader__.load({
	id: '@local/dsh-plugin-design',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		function DesignEditor({ sessionId, useSessions }) {
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
			if (!current.url) return h('div', { role: 'status', style: { padding: 20 } },
				h('p', null, current.error || '正在连接当前工作区…'),
				current.error && h('button', { type: 'button', onClick: () => retry(value => value + 1) }, '重新连接'));
			return h('iframe', {
				key: current.url,
				src: current.url,
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
