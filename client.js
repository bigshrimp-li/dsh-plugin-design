ow.__ModuleLoader__.load({
	id: '@local/dsh-plugin-design',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		/**
		 * 编辑器跑在宿主起的本地服务上，端口是固定的（见 src/tools.ts 的 EDITOR_PORT）。
		 * 侧边栏这里只拿得到 URL、拿不到"宿主当时选了哪个端口"，固定端口让两边不用协商。
		 * 端口被占时宿主会退到随机端口，那时用 design_editor 工具返回的 URL 在浏览器里打开。
		 */
		const EDITOR_URL = 'http://127.0.0.1:17321/';

		function DesignEditor() {
			return h('iframe', {
				src: EDITOR_URL,
				title: '设计稿编辑器',
				style: {
					width: '100%',
					height: '100%',
					border: '0',
					display: 'block',
					background: 'transparent',
				},
			});
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				// 会话右侧栏。槽位不在（宿主版本不同、或没有对话被选中）时安静跳过：
				// 编辑器仍然可以用 design_editor 工具给出的 URL 在浏览器里打开。
				const SLOTS = ['rightbar.session', 'shell.overlay'];
				for (const name of SLOTS) {
					try {
						ctx.slots.inject(name, () =>
							ctx.slots.register({ name, id: 'design-editor', order: 20 }, DesignEditor),
						);
						return;
					} catch {
						// 试下一个
					}
				}
			},
		};
	},
});
