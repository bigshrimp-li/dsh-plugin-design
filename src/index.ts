/** DeepSeek Harness design plugin: local editing, validation, rendering and export. */
import { registerDesignTools } from './tools.ts';
import { registerDesignSpaceHost } from './design-space/host.ts';
import { EditorManager } from './editor/manager.ts';
import { registerEditorHost, type EditorHostContext } from './editor/host.ts';

/** Loader 身份。 */
export const name = 'design-tools';

/** 依赖的服务：`ctx.tools`。缺它时插件保持不激活，而不是抛错。 */
export const inject = ['tools'];

/**
 * 注册五个设计工具。
 * @param ctx agent 作用域的服务。
 */
export function apply(ctx: {
  tools: { register: (tool: unknown) => unknown };
  get?: (name: string) => unknown;
  effect?: (fn: () => (() => void | Promise<void>)) => unknown;
  inject?: (services: string[], callback: (ctx: EditorHostContext) => void) => unknown;
}): void {
  const editors = new EditorManager();
  ctx.effect?.(() => () => editors.close());
  registerDesignTools(ctx, editors);
  // Optional web integration: CLI tools remain available without a web server.
  ctx.inject?.(['webServer', 'sessions', 'sessionPersistence'], host => { registerEditorHost(host, editors); registerDesignSpaceHost(host, editors); });
}
