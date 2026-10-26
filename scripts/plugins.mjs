import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export async function loadPlugins() {
  const catalog = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'plugins.json'), 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) throw new Error('不支持的插件目录格式');
  const ids = new Set(), packages = new Set();
  return Promise.all(catalog.plugins.map(async entry => {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || entry.path !== `plugins/${entry.id}` || ids.has(entry.id)) throw new Error(`插件 ID 或路径无效：${entry.id}`);
    ids.add(entry.id);
    const directory = path.join(repositoryRoot, entry.path);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    if (!manifest.name || packages.has(manifest.name)) throw new Error(`插件包名缺失或重复：${entry.id}`);
    packages.add(manifest.name);
    return { ...entry, directory, manifest };
  }));
}

export function selectPlugins(plugins, ids) {
  if (!ids.length) return plugins;
  const selected = [...new Set(ids)].map(id => plugins.find(plugin => plugin.id === id));
  if (selected.some(plugin => !plugin)) throw new Error(`未知插件；可选值：${plugins.map(p => p.id).join(', ')}`);
  return selected;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（${result.status ?? result.signal}）`);
}

export function runPluginScript(plugin, script) {
  const actual = script === 'test' && plugin.manifest.scripts?.['test:unit'] ? 'test:unit' : script;
  if (!plugin.manifest.scripts?.[actual]) return false;
  console.log(`\n[${plugin.id}] ${actual}`);
  run('npm', ['run', actual], { cwd: plugin.directory });
  return true;
}
