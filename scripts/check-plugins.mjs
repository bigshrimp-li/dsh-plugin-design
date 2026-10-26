import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlugins, selectPlugins, repositoryRoot } from './plugins.mjs';

export async function checkPlugins({ built = false, ids = [] } = {}) {
  const plugins = selectPlugins(await loadPlugins(), ids);
  const identities = new Set(), skillNames = new Set();
  const root = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  if (!root.private || root.dsh) throw new Error('工作区根包必须 private，且不能作为 DSH 插件加载');
  for (const plugin of plugins) {
    const { manifest, directory } = plugin;
    if (!['experimental', 'maintained'].includes(plugin.status)) throw new Error(`${plugin.id} 缺少成熟度`);
    for (const script of ['build', 'check', 'test']) if (!manifest.scripts?.[script]) throw new Error(`${plugin.id} 缺少 ${script} 脚本`);
    const patchFile = manifest.dsh?.bundle?.patch;
    if (!patchFile) throw new Error(`${plugin.id} 缺少 bundle patch`);
    const patch = await fs.readFile(path.join(directory, patchFile), 'utf8');
    if (!patch.includes(manifest.name)) throw new Error(`${plugin.id} patch 包名不匹配`);
    const patchId = patch.match(/\bid:\s*([\w-]+)/)?.[1];
    if (!patchId || identities.has(patchId)) throw new Error(`重复或缺失的 Loader ID：${patchId}`);
    identities.add(patchId);
    const client = await fs.readFile(path.join(directory, manifest.exports['./client']), 'utf8');
    if (!client.includes(`id: '${manifest.name}'`) && !client.includes(`id: "${manifest.name}"`)) throw new Error(`${plugin.id} 客户端模块 ID 不匹配`);
    for (const target of Object.values(manifest.exports)) {
      if (typeof target !== 'string' || target.includes('*') || (!built && target.startsWith('./dist/'))) continue;
      await fs.access(path.join(directory, target));
    }
    if (!manifest.files?.includes(patchFile.replace(/^\.\//, ''))) throw new Error(`${plugin.id} 打包缺少 patch`);
    if (manifest.files.some(file => /(^|\/)data(\/|$)/.test(file))) throw new Error(`${plugin.id} 分发清单不能包含本机 data/`);
    for (const skill of plugin.skills) {
      if (skillNames.has(skill)) throw new Error(`skill 重名：${skill}`);
      skillNames.add(skill);
      await fs.access(path.join(directory, 'skills', skill, 'SKILL.md'));
    }
    if (plugin.source.importRecord) await fs.access(path.join(repositoryRoot, plugin.source.importRecord));
  }
  return plugins;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plugins = await checkPlugins({ built: process.argv.includes('--built') });
    console.log(`PASS: ${plugins.length} 个插件的包名、Loader ID、客户端入口、skills 和分发清单检查通过。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
