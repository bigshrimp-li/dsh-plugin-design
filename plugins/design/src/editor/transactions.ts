/** Design-level operation history. The queue serializes this service, not external writers. */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { checkCanvas } from '../check/canvas-check.ts';
import type { CanvasIssue } from '../check/canvas-check.ts';

export type FileBytes = Buffer | null;
export type FileChanges = Record<string, string | Buffer | null>;
export const revisionOf = (value: string | Buffer | null): string | null => value === null ? null : createHash('sha256').update(value).digest('hex');
export class TransactionError extends Error {
  constructor(public status: number, public code: string, message: string, public problems: CanvasIssue[] = []) { super(message); this.name = 'TransactionError'; }
}
export interface HistoryStatus { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number; undoLabel?: string; redoLabel?: string }
export interface TransactionResult extends HistoryStatus {
  changed: boolean;
  files: string[];
  revisions: Record<string, string | null>;
  history: HistoryStatus;
  label?: string;
  origin?: unknown;
}
export interface Mutation {
  label: string;
  origin?: unknown;
  /** Includes every read dependency and every changed path. null means the file must not exist. */
  revisions: Record<string, string | null>;
  changes?: FileChanges;
  build?: (snapshot: Record<string, FileBytes>) => FileChanges | Promise<FileChanges>;
}
export interface HistoryEntry {
  label: string;
  origin?: unknown;
  before: Record<string, FileBytes>;
  after: Record<string, FileBytes>;
  /** Unchanged files that justified the operation, including expected absence. */
  dependencies: Record<string, FileBytes>;
  bytes: number;
}
interface History { undo: HistoryEntry[]; redo: HistoryEntry[] }
const equals = (a: FileBytes, b: FileBytes) => a === null || b === null ? a === b : a.equals(b);
const conflict = () => new TransactionError(409, 'revision_conflict', '设计稿已在别处修改，本次操作已停止。请重新加载后再编辑。');

export class EditorTransactions {
  private histories = new Map<string, History>();
  private queues = new Map<string, Promise<void>>();
  private maxEntries: number;
  private maxBytes: number;
  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024 * 1024);
  }
  private root(dir: string) { return realpathSync(dir); }
  private history(root: string): History {
    let value = this.histories.get(root);
    if (!value) { value = { undo: [], redo: [] }; this.histories.set(root, value); }
    return value;
  }
  status(dir: string): HistoryStatus {
    const h = this.history(this.root(dir));
    return { canUndo: h.undo.length > 0, canRedo: h.redo.length > 0, undoCount: h.undo.length, redoCount: h.redo.length, undoLabel: h.undo.at(-1)?.label, redoLabel: h.redo.at(-1)?.label };
  }
  private result(root: string, files: Record<string, FileBytes>, entry?: Pick<HistoryEntry, 'label' | 'origin'>): TransactionResult {
    const history = this.status(root);
    return { changed: Object.keys(files).length > 0, files: Object.keys(files), revisions: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, revisionOf(data)])), history, ...history, ...entry };
  }
  private async locked<T>(root: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(root, current);
    await previous;
    try { return await action(); }
    finally { release(); if (this.queues.get(root) === current) this.queues.delete(root); }
  }
  /** Reject aliases and symlinks, including an existing ancestor of a new asset. */
  private async safePath(root: string, rel: string): Promise<string> {
    if (!rel || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || rel.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new TransactionError(400, 'invalid_path', `无效的设计稿相对路径：${rel}`);
    }
    let current = root;
    for (const segment of rel.split('/')) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new TransactionError(400, 'unsafe_path', `不能通过符号链接编辑：${rel}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return current;
  }
  private async read(root: string, name: string): Promise<FileBytes> {
    const file = await this.safePath(root, name);
    try { return await fs.readFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async validate(root: string, phase: string) {
    const result = await checkCanvas(root);
    if (result.issues.length) throw new TransactionError(422, 'invalid_canvas', `${phase}设计稿校验失败，未提交修改。`, result.issues);
  }
  private async assertSnapshot(root: string, snapshot: Record<string, FileBytes>) {
    for (const [name, data] of Object.entries(snapshot)) if (!equals(await this.read(root, name), data)) throw conflict();
  }
  /** Candidate validation never exposes invalid intermediate markup in the real canvas. */
  private async validateCandidate(root: string, changes: Record<string, FileBytes>) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-editor-candidate-'));
    const candidate = path.join(temp, 'canvas');
    try {
      await fs.cp(root, candidate, { recursive: true, filter: async source => {
        if ((await fs.lstat(source)).isSymbolicLink()) throw new TransactionError(400, 'unsafe_path', '设计稿包含符号链接，不能安全提交。');
        return true;
      } });
      for (const [name, data] of Object.entries(changes)) {
        const dest = await this.safePath(candidate, name);
        if (data === null) await fs.rm(dest, { force: true });
        else { await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, data); }
      }
      await this.validate(candidate, '修改后的');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  private async writeConditional(root: string, name: string, before: FileBytes, after: FileBytes) {
    const dest = await this.safePath(root, name);
    if (after === null) {
      if (!equals(await this.read(root, name), before)) throw conflict();
      await fs.rm(dest, { force: true });
      return;
    }
    const staged = path.join(path.dirname(dest), `.dsh-write-${randomUUID()}`);
    try {
      await fs.writeFile(staged, after, { flag: 'wx' });
      await this.safePath(root, name);
      if (!equals(await this.read(root, name), before)) throw conflict();
      if (before === null) await fs.link(staged, dest);
      else await fs.rename(staged, dest);
    } finally {
      // Installation is already committed by link/rename. A cleanup error must
      // neither turn that success into an untracked failure nor replace the
      // original install error. A leftover dotfile is ignored by the canvas.
      await fs.rm(staged, { force: true }).catch(() => {});
    }
  }
  /** There is no cross-process CAS primitive here. Recheck immediately before each write,
   * and restore only bytes that still equal this operation's output on failure. */
  private async install(root: string, before: Record<string, FileBytes>, after: Record<string, FileBytes>, dependencies: Record<string, FileBytes> = before) {
    const written: string[] = [];
    const createdDirs: string[] = [];
    try {
      await this.assertSnapshot(root, dependencies);
      for (const [name, value] of Object.entries(after)) {
        const dest = await this.safePath(root, name);
        if (!equals(await this.read(root, name), before[name]!)) throw conflict();
        if (value !== null) {
          let parent = path.dirname(dest);
          const missing: string[] = [];
          while (parent !== root) {
            try { await fs.lstat(parent); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.unshift(parent); parent = path.dirname(parent); }
          }
          for (const dir of missing) { await fs.mkdir(dir); createdDirs.push(dir); }
        }
        await this.writeConditional(root, name, before[name]!, value);
        written.push(name);
      }
      await this.assertSnapshot(root, { ...dependencies, ...after });
      await this.validate(root, '保存后的');
      await this.assertSnapshot(root, { ...dependencies, ...after });
    } catch (error) {
      const unrecovered: string[] = [];
      for (const name of written.reverse()) {
        try {
          if (!equals(await this.read(root, name), after[name]!)) { unrecovered.push(name); continue; }
          await this.writeConditional(root, name, after[name]!, before[name]!);
        } catch { unrecovered.push(name); }
      }
      for (const dir of createdDirs.reverse()) await fs.rmdir(dir).catch(() => {});
      if (unrecovered.length) throw new TransactionError(409, 'rollback_conflict', '保存期间发生外部修改，已保留外部内容；请重新加载并检查受影响文件。', unrecovered.map(file => ({ file, message: 'External update prevented conditional rollback.' })));
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict();
      throw error;
    }
  }
  async mutate(dir: string, request: Mutation): Promise<TransactionResult> {
    const root = this.root(dir);
    return this.locked(root, async () => {
      if (!request.revisions || typeof request.revisions !== 'object') throw new TransactionError(400, 'revision_required', '保存必须提供读取版本。');
      const snapshot: Record<string, FileBytes> = Object.create(null);
      for (const [name, expected] of Object.entries(request.revisions)) {
        const data = await this.read(root, name);
        if (revisionOf(data) !== expected) throw conflict();
        snapshot[name] = data;
      }
      await this.validate(root, '当前');
      const changes = request.build ? await request.build(Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, value === null ? null : Buffer.from(value)]))) : request.changes;
      if (!changes || typeof changes !== 'object') throw new TransactionError(400, 'changes_required', '缺少要保存的修改。');
      const before: Record<string, FileBytes> = Object.create(null);
      const after: Record<string, FileBytes> = Object.create(null);
      for (const [name, data] of Object.entries(changes)) {
        if (!Object.hasOwn(snapshot, name)) throw new TransactionError(400, 'revision_required', `保存缺少文件版本：${name}`);
        if (data !== null && typeof data !== 'string' && !Buffer.isBuffer(data)) throw new TransactionError(400, 'invalid_content', `无效的文件内容：${name}`);
        const value = data === null ? null : Buffer.from(data);
        if (!equals(value, snapshot[name]!)) { before[name] = snapshot[name]!; after[name] = value; }
      }
      if (!Object.keys(after).length) { await this.assertSnapshot(root, snapshot); return this.result(root, {}); }
      const dependencies = Object.fromEntries(Object.entries(snapshot).filter(([name]) => !Object.hasOwn(after, name)));
      const bytes = [...Object.values(before), ...Object.values(after), ...Object.values(dependencies)].reduce<number>((sum, data) => sum + (data?.byteLength ?? 0), 0);
      if (bytes > this.maxBytes) throw new TransactionError(413, 'history_limit', '本次修改超过可撤销历史的内存上限，请缩小操作范围。');
      await this.validateCandidate(root, after);
      await this.assertSnapshot(root, snapshot);
      await this.install(root, before, after, snapshot);
      const h = this.history(root);
      const entry = { before, after, dependencies, bytes, label: request.label, origin: request.origin };
      h.undo.push(entry); h.redo = [];
      let total = h.undo.reduce((sum, value) => sum + value.bytes, 0);
      while (h.undo.length > this.maxEntries || total > this.maxBytes) total -= h.undo.shift()!.bytes;
      return this.result(root, after, entry);
    });
  }
  async undo(dir: string): Promise<TransactionResult> { return this.moveHistory(dir, 'undo'); }
  async redo(dir: string): Promise<TransactionResult> { return this.moveHistory(dir, 'redo'); }
  private async moveHistory(dir: string, direction: 'undo' | 'redo'): Promise<TransactionResult> {
    const root = this.root(dir);
    return this.locked(root, async () => {
      const h = this.history(root);
      const stack = h[direction];
      const entry = stack.at(-1);
      if (!entry) return this.result(root, {});
      const before = direction === 'undo' ? entry.after : entry.before;
      const after = direction === 'undo' ? entry.before : entry.after;
      const expected = { ...entry.dependencies, ...before };
      await this.assertSnapshot(root, expected);
      await this.validate(root, '当前');
      await this.validateCandidate(root, after);
      await this.install(root, before, after, expected);
      stack.pop(); h[direction === 'undo' ? 'redo' : 'undo'].push(entry);
      return this.result(root, after, entry);
    });
  }
}
