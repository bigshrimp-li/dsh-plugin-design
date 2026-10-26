import { startServer } from './server.mjs';

export const inject = [];

/**
 * Agent Session Visualizer (Host 插件)
 * 负责启动并维持多 Provider (Codex / Claude / Grok / Noval) 会话数据服务
 */
export function apply(ctx, config = {}) {
  const port = Number(config.port || process.env.ASV_PORT || 3789);
  let serverInstance = null;

  async function init() {
    try {
      serverInstance = await startServer({ port, host: '127.0.0.1' });
      const statusMsg = serverInstance.reused
        ? `[ASV] Reusing existing service at http://127.0.0.1:${serverInstance.port}`
        : `[ASV] Started service at http://127.0.0.1:${serverInstance.port}`;
      if (ctx.logger && ctx.logger.info) {
        ctx.logger.info(statusMsg);
      } else {
        console.log(statusMsg);
      }
    } catch (err) {
      if (ctx.logger && ctx.logger.warn) {
        ctx.logger.warn(`[ASV] Failed to start service on port ${port}: ${err.message}`);
      } else {
        console.warn(`[ASV] Failed to start service on port ${port}:`, err);
      }
    }
  }

  init();

  ctx.on('dispose', async () => {
    if (serverInstance && serverInstance.close) {
      try {
        await serverInstance.close();
      } catch (_) {}
    }
  });
}
