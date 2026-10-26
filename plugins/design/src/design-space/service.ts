import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { checkCanvas } from '../check/canvas-check.ts';

export class SpaceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Directory {
  id: string;
  path: string;
  workspace: string;
  label: string;

}
interface Sidecar {
  version: 1;
  revision: number;
  links: Record<string, string>;
  sessions?: Record<string, string[]>;
  operations: Record<string, string>;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const emptyLinks = (): Sidecar => ({ version: 1, revision: 0, links: {}, operations: {} });
const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
async function readJSON<T>(file: string, fallback: () => T): Promise<T> {
  try {
    for (const candidate of [path.dirname(file), file]) {
      const st = await fs.lstat(candidate);
      if (st.isSymbolicLink()) throw new Error('配置路径不能是符号链接');
    }
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) throw new Error('文件过大');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (absent(e)) return fallback();
    throw new SpaceError(422, `配置无法读取，请保留原文件后修复：${file}`);
  }
}
// Serialize writes in this process before taking the cross-process lock. Workspace
// discovery can register several roots at once; those are not conflicting users.
const writes = new Map<string, Promise<unknown>>();
async function updateJSON<T extends { version: number; revision: number }>(
  file: string,
  fallback: () => T,
  mutate: (state: T) => Promise<void> | void,
  expected?: number,
): Promise<T> {
  const key = path.resolve(file);
  const pending = (writes.get(key) || Promise.resolve())
    .catch(() => {})
    .then(() => updateJSONLocked(file, fallback, mutate, expected));
  writes.set(key, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(key) === pending) writes.delete(key);
  }
}
/** Local lock is exclusive across plugin processes; abandoned lock is deliberately not overwritten. */
async function updateJSONLocked<T extends { version: number; revision: number }>(
  file: string,
  fallback: () => T,
  mutate: (state: T) => Promise<void> | void,
  expected?: number,
): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const target of [path.dirname(file), file]) {
    try {
      if ((await fs.lstat(target)).isSymbolicLink())
        throw new SpaceError(400, '配置路径不能是符号链接');
    } catch (e) {
      if (!absent(e)) throw e;
    }
  }
  let lock;
  try {
    lock = await fs.open(file + '.lock', 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw new SpaceError(
        409,
        `另一个窗口正在保存，或上次保存中断。请重试；若持续失败请检查 ${file}.lock`,
      );
    throw e;
  }
  const temp = file + '.' + randomUUID() + '.tmp',
    backupTemp = temp + '.bak';
  try {
    const state = await readJSON(file, fallback);
    if (
      !record(state) ||
      state.version !== 1 ||
      !Number.isInteger(state.revision) ||
      state.revision < 0
    )
      throw new SpaceError(422, '配置版本或结构无效，原文件已保留');
    if (expected !== undefined && state.revision !== expected)
      throw new SpaceError(409, '配置已在其他窗口更新，请刷新后重试');
    await mutate(state);
    state.revision++;
    const old = await fs.readFile(file).catch((e) => {
      if (absent(e)) return null;
      throw e;
    });
    if (old) {
      await fs.writeFile(backupTemp, old, { mode: 0o600, flag: 'wx' });
      await fs.rename(backupTemp, file + '.bak');
    }
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    return state;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
    await fs.rm(backupTemp, { force: true }).catch(() => {});
    await lock.close();
    await fs.rm(file + '.lock', { force: true });
  }
}
interface DraftMetadata { version: 1; revision: number; archived?: boolean }
const emptyMetadata = (): DraftMetadata => ({ version: 1, revision: 0 });
const folderName = (value: string) => {
  const name = value.trim();
  if (!name || name.length > 120 || name.startsWith('.') || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name))
    throw new SpaceError(400, '设计稿名称须为1–120个字符，不能以点开头或包含路径分隔符等文件名禁用字符');
  return name;
};

/** One immediate child of ~/.design is one draft. No arbitrary workspace registration. */
export class DesignSpaceService {
  constructor(public root = path.join(os.homedir(), '.design')) {}
  private async rootPath() {
    await fs.mkdir(this.root, { recursive: true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new SpaceError(400, '设计区目录不能是符号链接');
    return fs.realpath(this.root);
  }
  private metadata(target: string) { return path.join(target, '.dsh', 'design-space.json'); }
  private async entries() {
    const root = await this.rootPath();
    const result: Directory[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const target = path.join(root, entry.name);
      try {
        const stat = await fs.stat(target);
        // Directory identity survives both in-app and external filesystem renames.
        result.push({ id: hash(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`), path: target, workspace: root, label: entry.name });
      } catch (error) { if (!absent(error)) throw error; }
    }
    return result.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
  }
  async directory(id: string) {
    const d = (await this.entries()).find(d => d.id === id);
    if (!d) throw new SpaceError(404, '设计稿文件夹已移除，请刷新设计区');
    if ((await fs.realpath(d.path)) !== d.path) throw new SpaceError(409, '设计稿目录位置已变化，请刷新');
    return d;
  }
  async rename(id: string, label: string) {
    const name = folderName(label);
    // Serialize rename/create/archive, and never replace an existing folder, including an empty one.
    await updateJSON(path.join(await this.rootPath(), '.dsh', 'operations.json'), emptyLinks, async () => {
      const d = await this.directory(id);
      if (d.label === name) return;
      const destination = path.join(d.workspace, name);
      try { await fs.lstat(destination); throw new SpaceError(409, '同名设计稿已存在，请使用其他名称'); }
      catch (error) { if (!absent(error)) throw error; }
      await fs.rename(d.path, destination);
    });
    return this.describe(id);
  }
  async archive(id: string) {
    await updateJSON(path.join(await this.rootPath(), '.dsh', 'operations.json'), emptyLinks, async () => {
      const d = await this.directory(id);
      await updateJSON(this.metadata(d.path), emptyMetadata, s => { s.archived = true; });
    });
    return { ok: true };
  }
  async locate(id: string, rel = '.') {
    if (rel !== '.') throw new SpaceError(400, '每个设计稿只绑定设计区内的一个直接子文件夹');
    const d = await this.directory(id);
    const metadata = await readJSON(this.metadata(d.path), emptyMetadata);
    if (metadata.archived) throw new SpaceError(409, '设计稿已归档');
    return { directory: d, target: d.path, canvas: path.basename(d.path), identity: d.id };
  }
  private sidecar(target: string) { return path.join(target, '.dsh', 'design-tabs.json'); }
  async links(workspace: string) {
    const s = await readJSON(this.sidecar(workspace), emptyLinks);
    if (
      !s ||
      s.version !== 1 ||
      !Number.isInteger(s.revision) ||
      !record(s.links) ||
      !record(s.operations) ||
      Object.values(s.links).some((v) => typeof v !== 'string') ||
      (s.sessions !== undefined &&
        (!record(s.sessions) ||
          Object.values(s.sessions).some(
            (v) => !Array.isArray(v) || v.some((id) => typeof id !== 'string' || !id),
          ))) ||
      Object.values(s.operations).some((v) => typeof v !== 'string')
    )
      throw new SpaceError(422, '设计会话配置损坏，请检查 .dsh/design-tabs.json（原文件已保留）');
    return s;
  }
  async describe(id: string, rel = '.') {
    const l = await this.locate(id, rel);
    let index;
    try { index = JSON.parse(await fs.readFile(path.join(l.target, 'canvas.json'), 'utf8')); }
    catch (error) {
      if (absent(error)) return { ...l, status: 'empty', title: l.directory.label, count: 0 };
      return { ...l, status: 'invalid', title: l.directory.label, count: 0 };
    }
    if (!index || index.v !== 3 || !Array.isArray(index.order) || !index.boards || index.order.some((b: unknown) => typeof b !== 'string' || !index.boards[b]))
      return { ...l, status: 'invalid', title: l.directory.label, count: 0 };
    let sessionId, linkError, linkRevision;
    let sessionIds: string[] = [];
    try {
      const links = await this.links(l.target);
      sessionId = links.links['.'];
      sessionIds = [...new Set([...(links.sessions?.['.'] || []), ...(sessionId ? [sessionId] : [])])];
      linkRevision = links.revision;
    } catch (error) { linkError = (error as Error).message; }
    return {
      ...l, status: 'ready', title: l.directory.label, count: index.order.length,
      preview: index.order.length ? { board: index.order[0], ...index.boards[index.order[0]] } : undefined,
      sessionId, sessionIds, linkError, linkRevision,
      updatedAt: (await fs.stat(path.join(l.target, 'canvas.json'))).mtimeMs,
    };
  }
  async list() {
    const directories = [];
    for (const d of await this.entries()) {
      try {
        const metadata = await readJSON(this.metadata(d.path), emptyMetadata);
        if (metadata.archived) continue;
        directories.push({ ...d, info: await this.describe(d.id) });
      } catch (error) { if (!absent(error)) directories.push({ ...d, info: { status: 'unavailable', error: (error as Error).message } }); }
    }
    return { root: await this.rootPath(), directories };
  }
  async bind(id: string, rel: string, sessionId: string, sessionCwd: string, expected?: number) {
    let result!: Sidecar;
    await updateJSON(path.join(await this.rootPath(), '.dsh', 'operations.json'), emptyLinks, async () => {
      const l = await this.locate(id, rel);
      if ((await fs.realpath(sessionCwd)) !== l.directory.workspace)
        throw new SpaceError(409, '此会话不属于设计区，请选择设计区内的会话');
      await this.links(l.target);
      result = await updateJSON(this.sidecar(l.target), emptyLinks, s => {
        s.sessions ??= {};
        s.sessions['.'] = [...new Set([...(s.sessions['.'] || []), ...(s.links['.'] ? [s.links['.']] : []), sessionId])];
        s.links['.'] = sessionId;
      }, expected);
    });
    return result;
  }
  private async initialize(target: string, title: string, preset = 'blank') {
    const sizes: Record<string, [number, number]> = { blank: [880, 560], mobile: [390, 844], web: [1440, 1000], a4: [794, 1123], a3: [1123, 1587] };
    const size = sizes[preset];
    if (!size) throw new SpaceError(400, '未知设计预设');
    const [w, h] = size;
    const index = {
      v: 3,
      createdOnFiles: { v: 1, at: (await fs.stat(target)).birthtime.toISOString() },
      title: title.trim(),
      launch: { view: 'canvas' },
      pages: [],
      boards: { 'Main.dc.html': { x: 0, y: 0, w, h, title: '画板 1' } },
      order: ['Main.dc.html'],
      notes: {},
      designSystems: [],
    };
    const html = `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>${escapeHTML(title)}</title>\n<script src="./support.js"></script>\n</head>\n<body>\n<x-dc>\n<helmet><style>body{margin:0}</style></helmet>\n<div style="width: ${w}px; height: ${h}px; box-sizing: border-box; background: #ffffff"></div>\n</x-dc>\n<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>\nclass Component extends DCLogic { renderVals() { return {}; } }\n</script>\n</body>\n</html>\n`;
    const install = async (name: string, content: string) => {
      const destination = path.join(target, name);
      try {
        await fs.writeFile(destination, content, { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (
          (await fs.lstat(destination)).isSymbolicLink() ||
          (await fs.readFile(destination, 'utf8')) !== content
        )
          throw new SpaceError(409, '创建中的文件已被修改，请打开现有设计稿继续，未覆盖文件');
      }
    };
    try {
      await install('canvas.json', JSON.stringify(index, null, 2) + '\n');
      await install('Main.dc.html', html);
      const checked = await checkCanvas(target);
      if (checked.issues.length) throw new Error(JSON.stringify(checked.issues));
    } catch (e) {
      throw new SpaceError(
        422,
        `创建未完成，文件保留在 ${target}，请检查后重试：${(e as Error).message}`,
      );
    }
  }
  async ensure(id: string) {
    const info = await this.describe(id);
    if (info.status === 'empty') {
      await updateJSON(path.join(await this.rootPath(), '.dsh', 'operations.json'), emptyLinks, async () => {
        const current = await this.describe(id);
        if (current.status === 'empty') await this.initialize(current.target, current.title);
      });
    }
    return this.describe(id);
  }
  async conversationTargets(sessionId: string) {
    const targets = [];
    for (const directory of await this.entries()) {
      const links = await this.links(directory.path);
      if (Object.values(links.links).includes(sessionId) || Object.values(links.sessions || {}).some(ids => ids.includes(sessionId))) targets.push(directory.id);
    }
    return targets;
  }
  async saveConversation(id: string, sessionId: string, header: unknown, events: unknown[]) {
    const root = await this.rootPath();
    await updateJSON(path.join(root, '.dsh', 'operations.json'), emptyLinks, async () => {
      const target = (await this.directory(id)).path;
      if (!inside(root, target) || (await fs.realpath(target)) !== target || !(await fs.stat(target)).isDirectory())
        throw new SpaceError(409, '设计稿文件夹已变化');
      const metadata = path.join(target, '.dsh');
      await fs.mkdir(metadata, { recursive: true });
      if ((await fs.lstat(metadata)).isSymbolicLink()) throw new SpaceError(400, '对话目录不能是符号链接');
      const directory = path.join(metadata, 'conversations');
      await fs.mkdir(directory, { recursive: true });
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new SpaceError(400, '对话目录不能是符号链接');
      const destination = path.join(directory, hash(sessionId) + '.json');
      const temp = destination + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temp, JSON.stringify({ version: 1, sessionId, header, events }) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, destination);
      } finally { await fs.rm(temp, { force: true }); }
    });
  }
  async create(operationId: string, requestedName?: string, preset = 'blank') {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(operationId)) throw new SpaceError(400, '创建操作标识无效');
    const sizes: Record<string, [number, number]> = { blank: [880, 560], mobile: [390, 844], web: [1440, 1000], a4: [794, 1123], a3: [1123, 1587] };
    const size = sizes[preset];
    if (!size) throw new SpaceError(400, '未知设计预设');
    const root = await this.rootPath();
    let target = '';
    await updateJSON(path.join(root, '.dsh', 'operations.json'), emptyLinks, async state => {
      const matches = async (directory: Directory) => {
        const receipt = await readJSON<{ operationId?: string; requestedName?: string; preset?: string }>(path.join(directory.path, '.dsh-creation.json'), () => ({}));
        if (receipt.operationId !== operationId) return false;
        if (receipt.requestedName !== requestedName || receipt.preset !== preset) throw new SpaceError(409, '同一操作不能用于创建不同设计稿');
        target = directory.path;
        state.operations[operationId] = directory.id;
        await this.initialize(target, directory.label, preset);
        return true;
      };
      const prior = state.operations[operationId];
      if (prior) {
        const directory = await this.directory(prior);
        // A completed design may already have user edits or have been renamed.
        target = directory.path;
        const receipt = await readJSON<{ requestedName?: string; preset?: string }>(path.join(target, '.dsh-creation.json'), () => ({}));
        if (receipt.requestedName !== requestedName || receipt.preset !== preset) throw new SpaceError(409, '同一操作不能用于创建不同设计稿');
        return;
      }
      for (const directory of await this.entries()) if (await matches(directory)) return;
      let name = requestedName ? folderName(requestedName) : '未命名设计稿';
      for (let suffix = 2; ; suffix++) {
        target = path.join(root, name);
        try { await fs.mkdir(target); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (requestedName) throw new SpaceError(409, '同名设计稿已存在，未覆盖文件');
          name = `未命名设计稿 ${suffix}`;
        }
      }
      await fs.writeFile(path.join(target, '.dsh-creation.json'), JSON.stringify({ operationId, requestedName, preset }), { flag:'wx', mode:0o600 });
      const title = name;
      await this.initialize(target, title, preset);
      const d = (await this.entries()).find(d => d.path === target)!;
      state.operations[operationId] = d.id;
    });
    const d = (await this.entries()).find(d => d.path === target)!;
    return { ...(await this.describe(d.id)), id: d.id, rel: '.' };
  }
}
