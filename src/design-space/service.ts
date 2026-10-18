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
  hidden?: boolean;
  legacyWorkspace?: string;
}
interface State {
  version: 1;
  revision: number;
  directories: Directory[];
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
const initial = (): State => ({ version: 1, revision: 0, directories: [] });
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
export class DesignSpaceService {
  constructor(
    public stateFile = path.join(os.homedir(), '.dsh', 'design-space', 'directories.json'),
  ) {}
  async state() {
    const s = await readJSON(this.stateFile, initial);
    if (
      !s ||
      s.version !== 1 ||
      !Number.isInteger(s.revision) ||
      !Array.isArray(s.directories) ||
      s.directories.some(
        (d) =>
          !d ||
          typeof d.id !== 'string' ||
          typeof d.path !== 'string' ||
          typeof d.workspace !== 'string' ||
          (d.legacyWorkspace !== undefined && typeof d.legacyWorkspace !== 'string') ||
          typeof d.label !== 'string',
      )
    )
      throw new SpaceError(422, '目录配置版本或结构无效');
    return s;
  }
  async register(directory: string, workspace?: string, hidden = false) {
    if (!path.isAbsolute(directory)) throw new SpaceError(400, '请选择绝对目录');
    const real = await fs.realpath(directory);
    if (!(await fs.stat(real)).isDirectory()) throw new SpaceError(400, '选择的路径不是目录');
    const owner = workspace ? await fs.realpath(workspace) : real;
    if (!inside(owner, real)) throw new SpaceError(400, '设计目录不在所选工作区内');
    const entry = {
      id: hash(real),
      path: real,
      workspace: owner,
      label: path.basename(real),
      hidden,
    };
    const prior = (await this.state()).directories.find((d) => d.id === entry.id);
    if (prior && (hidden || !prior.hidden)) return prior;
    await updateJSON(this.stateFile, initial, (s) => {
      if (s.directories.length >= 100 && !s.directories.some((d) => d.id === entry.id))
        throw new SpaceError(400, '最多登记100个设计目录');
      const old = s.directories.find((d) => d.id === entry.id);
      if (old) {
        old.hidden = false;
      } else s.directories.push(entry);
    });
    return (await this.state()).directories.find((d) => d.id === entry.id)!;
  }
  async directory(id: string) {
    const d = (await this.state()).directories.find((d) => d.id === id);
    if (!d) throw new SpaceError(404, '设计目录未登记，请重新添加');
    if ((await fs.realpath(d.path)) !== d.path || (await fs.realpath(d.workspace)) !== d.workspace)
      throw new SpaceError(409, '目录位置已变化，请重新添加');
    return d;
  }
  /** Adopt a registered directory as an independent space; keep old files and sessions intact. */
  async space(id: string) {
    const d = await this.directory(id);
    if (d.workspace === d.path) return d;
    const legacy = await this.links(d.workspace);
    await this.links(d.path);
    await updateJSON(this.sidecar(d.path), emptyLinks, (s) => {
      s.sessions ??= {};
      for (const key of new Set([...Object.keys(legacy.links), ...Object.keys(legacy.sessions || {})])) {
        const target = path.resolve(d.workspace, key);
        if (!inside(d.path, target)) continue;
        const rel = path.relative(d.path, target) || '.';
        s.sessions[rel] = [...new Set([
          ...(s.sessions[rel] || []), ...(s.links[rel] ? [s.links[rel]] : []),
          ...(legacy.sessions?.[key] || []), ...(legacy.links[key] ? [legacy.links[key]] : []),
        ])];
        s.links[rel] ??= legacy.links[key];
      }
      // Preserve operation receipts so interrupted creation remains idempotent.
      for (const [key, value] of Object.entries(legacy.operations)) s.operations[key] ??= value;
    });
    await updateJSON(this.stateFile, initial, (s) => {
      const current = s.directories.find((item) => item.id === id);
      if (!current) throw new SpaceError(404, '设计空间已移除');
      current.legacyWorkspace ??= current.workspace;
      current.workspace = current.path;
    });
    return this.directory(id);
  }
  async rename(id: string, label: string) {
    await this.state();
    if (!label.trim() || label.length > 120) throw new SpaceError(400, '显示名称须为1–120个字符');
    return updateJSON(this.stateFile, initial, (s) => {
      const d = s.directories.find((d) => d.id === id);
      if (!d) throw new SpaceError(404, '目录未登记');
      d.label = label.trim();
    });
  }
  async remove(id: string) {
    await this.state();
    return updateJSON(this.stateFile, initial, (s) => {
      s.directories = s.directories.filter((d) => d.id !== id);
    });
  }
  async locate(id: string, rel = '.') {
    const d = await this.directory(id);
    if (
      path.isAbsolute(rel) ||
      rel.includes('\\') ||
      rel.includes('\0') ||
      rel.split('/').includes('..')
    )
      throw new SpaceError(400, '设计稿路径无效');
    const target = await fs.realpath(path.resolve(d.path, rel));
    if (!inside(d.path, target)) throw new SpaceError(400, '设计稿路径越界');
    return {
      directory: d,
      target,
      canvas: path.relative(d.workspace, target) || '.',
      identity: hash(target),
    };
  }
  private sidecar(workspace: string) {
    return path.join(workspace, '.dsh', 'design-tabs.json');
  }
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
    try {
      index = JSON.parse(await fs.readFile(path.join(l.target, 'canvas.json'), 'utf8'));
    } catch (e) {
      if (absent(e)) {
        const entries = await fs.readdir(l.target);
        return {
          ...l,
          status: entries.some((name) => !name.startsWith('.')) ? 'container' : 'empty',
          title: path.basename(l.target),
          count: 0,
        };
      }
      return { ...l, status: 'invalid', title: path.basename(l.target), count: 0 };
    }
    if (
      !index ||
      index.v !== 3 ||
      !Array.isArray(index.order) ||
      !index.boards ||
      index.order.some((b: unknown) => typeof b !== 'string' || !index.boards[b])
    )
      return { ...l, status: 'invalid', title: index?.title || path.basename(l.target), count: 0 };
    let sessionId, linkError, linkRevision;
    let sessionIds: string[] = [];
    try {
      const links = await this.links(l.directory.workspace);
      sessionId = links.links[l.canvas];
      sessionIds = [
        ...new Set([...(links.sessions?.[l.canvas] || []), ...(sessionId ? [sessionId] : [])]),
      ];
      linkRevision = links.revision;
    } catch (e) {
      linkError = (e as Error).message;
    }
    return {
      ...l,
      status: 'ready',
      title: index.title || path.basename(l.target),
      count: index.order.length,
      preview: index.order.length
        ? { board: index.order[0], ...index.boards[index.order[0]] }
        : undefined,
      sessionId,
      sessionIds,
      linkError,
      linkRevision,
      updatedAt: (await fs.stat(path.join(l.target, 'canvas.json'))).mtimeMs,
    };
  }
  async list() {
    const s = await this.state();
    return {
      ...s,
      directories: await Promise.all(
        s.directories
          .filter((d) => !d.hidden)
          .map(async (d) => {
            try {
              return { ...d, info: await this.describe(d.id) };
            } catch (e) {
              return { ...d, info: { status: 'unavailable', error: (e as Error).message } };
            }
          }),
      ),
    };
  }
  async discover(id: string) {
    const d = await this.directory(id);
    const results: unknown[] = [];
    let visited = 0;
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || results.length >= 60 || ++visited > 800) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.some((e) => e.name === 'canvas.json' && e.isFile())) {
        results.push({
          ...(await this.describe(id, path.relative(d.path, dir) || '.')),
          rel: path.relative(d.path, dir) || '.',
        });
      }
      for (const e of entries)
        if (
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          !e.name.startsWith('.') &&
          !['node_modules', 'vendor', 'dist'].includes(e.name)
        )
          await walk(path.join(dir, e.name), depth + 1);
    };
    await walk(d.path, 0);
    return { items: results, truncated: visited > 800 || results.length >= 60 };
  }
  async bind(id: string, rel: string, sessionId: string, sessionCwd: string, expected?: number) {
    const l = await this.locate(id, rel);
    const prior = await this.links(l.directory.workspace);
    const cwd = await fs.realpath(sessionCwd);
    const legacySession = cwd === l.directory.legacyWorkspace &&
      [prior.links[l.canvas], ...(prior.sessions?.[l.canvas] || [])].includes(sessionId);
    if (cwd !== l.directory.workspace && !legacySession)
      throw new SpaceError(409, '此会话不属于设计稿工作区，请选择同工作区的会话');
    return updateJSON(
      this.sidecar(l.directory.workspace),
      emptyLinks,
      (s) => {
        s.sessions ??= {};
        s.sessions[l.canvas] = [
          ...new Set([
            ...(s.sessions[l.canvas] || []),
            ...(s.links[l.canvas] ? [s.links[l.canvas]] : []),
            sessionId,
          ]),
        ];
        s.links[l.canvas] = sessionId;
      },
      expected,
    );
  }
  async create(id: string, name: string, title: string, preset: string, operationId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
      throw new SpaceError(400, '目录名请用字母、数字、短横线或下划线，最多64位');
    if (!title.trim() || title.length > 120) throw new SpaceError(400, '标题须为1–120个字符');
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(operationId)) throw new SpaceError(400, '创建操作标识无效');
    const sizes: Record<string, [number, number]> = {
      blank: [880, 560],
      mobile: [390, 844],
      web: [1440, 1000],
      a4: [794, 1123],
      a3: [1123, 1587],
    };
    const size = sizes[preset];
    if (!size) throw new SpaceError(400, '未知设计预设');
    const d = await this.space(id);
    const rootCanvas = await fs.lstat(path.join(d.path, 'canvas.json')).catch((e) => {
      if (absent(e)) return null;
      throw e;
    });
    if (rootCanvas)
      throw new SpaceError(400, '此目录本身是一份设计稿，请将它的上级目录添加为设计空间，再新建设计稿');
    const target = path.join(d.path, name);
    const file = this.sidecar(d.workspace);
    await this.links(d.workspace);
    await updateJSON(file, emptyLinks, async (state) => {
      const key = hash(JSON.stringify([d.path, name, title, preset]));
      const prior = state.operations[operationId];
      if (prior) {
        if (prior !== key) throw new SpaceError(409, '同一操作不能用于创建不同设计稿');
        return;
      }
      const receipt = path.join(target, '.dsh-creation.json');
      try {
        await fs.mkdir(target);
        await fs.writeFile(receipt, JSON.stringify({ operationId, key }), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const saved = await readJSON<{ operationId?: string; key?: string }>(receipt, () => ({}));
        if (
          (await fs.realpath(target)) !== target ||
          saved.operationId !== operationId ||
          saved.key !== key
        )
          throw new SpaceError(409, '目录已存在，未覆盖任何文件。请更换目录名，或打开已有设计稿');
      }
      const [w, h] = size;
      const index = {
        v: 3,
        createdOnFiles: { v: 1, at: (await fs.stat(receipt)).birthtime.toISOString() },
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
      state.operations[operationId] = key;
    });
    return { ...(await this.describe(id, name)), rel: name };
  }
}
