import path from 'node:path';
import { startEditor, type EditorHandle } from './server.ts';

/** One pool per plugin lifetime, shared by the native tab and agent tool. */
export class EditorManager {
  private readonly editors = new Map<string, Promise<EditorHandle>>();
  private disposed = false;

  open(workspaceDir: string): Promise<EditorHandle> {
    if (this.disposed) return Promise.reject(new Error('设计稿插件已停止，请重新打开插件'));
    const workspace = path.resolve(workspaceDir);
    let pending = this.editors.get(workspace);
    if (!pending) {
      pending = startEditor({ workspaceDir: workspace }).catch(error => {
        this.editors.delete(workspace);
        throw error;
      });
      this.editors.set(workspace, pending);
    }
    return pending;
  }

  async close(): Promise<void> {
    this.disposed = true;
    const pending = [...this.editors.values()];
    this.editors.clear();
    await Promise.allSettled(pending.map(async entry => (await entry).close()));
  }
}
