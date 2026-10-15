/**
 * DSH Host 插件：BaoCut 的 design / design-system 工具。
 *
 * 提供五个工具：
 *   design_check                  校验一份设计稿（canvas.json + *.dc.html）——只看文件
 *   design_render                 把画板渲染成 PNG 并交回会话——唯一能看见设计的手段（本插件新增）
 *   design_import_asset           把图片/字体导入设计稿的 assets/
 *   design_system_check           校验一个设计系统
 *   design_system_import_asset    把图片/视频/PDF/字体导入设计系统的 _blobs/
 *
 * 校验代码不渲染、不联网、无外部依赖；渲染用随包的画板运行时（vendor/support.js）+ 无头 Chrome；
 * 素材导入写 node:fs。
 */
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
