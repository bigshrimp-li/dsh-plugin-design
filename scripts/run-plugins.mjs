import { loadPlugins, selectPlugins, runPluginScript } from './plugins.mjs';

try {
  const [action = 'list', ...ids] = process.argv.slice(2);
  const plugins = selectPlugins(await loadPlugins(), ids);
  if (action === 'list') {
    for (const p of plugins) console.log(`${p.id}\t${p.manifest.name}@${p.manifest.version}\t${p.status}`);
  } else {
    if (!['build', 'check', 'test', 'test:host', 'test:browser'].includes(action)) throw new Error(`未知命令：${action}`);
    let count = 0;
    for (const plugin of plugins) if (runPluginScript(plugin, action)) count++;
    if (!count) throw new Error(`所选插件没有 ${action} 脚本`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
