import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { checkPlugins } from './check-plugins.mjs';
import { repositoryRoot, selectPlugins, run, runPluginScript } from './plugins.mjs';

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function readJSON(file, fallback) {
  return await exists(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : fallback;
}
async function writeJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}
async function treeHash(directory) {
  const hash = createHash('sha256');
  async function visit(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) throw new Error(`skill 含符号链接：${dir}/${entry.name}`);
      const name = `${prefix}${entry.name}`;
      hash.update(name + '\0');
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), name + '/');
      else hash.update(await fs.readFile(path.join(dir, entry.name)));
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function install() {
  const args = process.argv.slice(2), ids = [];
  let profile = 'desktop', all = false, dryRun = false, skipBuild = false, keepSkills = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--profile' || arg === '--plugin') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      if (arg === '--profile') profile = value; else ids.push(value);
    } else if (arg === '--all') all = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--skip-build') skipBuild = true;
    else if (arg === '--keep-skills') keepSkills = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('用法：./install.sh [--plugin ID | --all] [--profile NAME] [--dry-run] [--skip-build] [--keep-skills]\n无参数只安装 Design；--plugin 可以重复。--keep-skills 保留已存在的 skills。DSH_BIN 与 DSH_HOME 可覆盖默认路径。');
      return;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(profile)) throw new Error('profile 名称无效');
  if (all && ids.length) throw new Error('--all 与 --plugin 不能同时使用');
  const plugins = selectPlugins(await checkPlugins(), all ? [] : ids.length ? ids : ['design']);
  const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const profileDir = path.join(dshHome, 'profiles', profile);
  const skillsDir = path.join(dshHome, 'skills');
  const ownersFile = path.join(dshHome, 'plugin-skill-owners.json');
  const owners = await readJSON(ownersFile, {}), skills = [];
  for (const plugin of plugins) for (const name of plugin.skills) {
    const source = path.join(plugin.directory, 'skills', name);
    const destination = path.join(skillsDir, name);
    const sourceHash = await treeHash(source);
    const destinationHash = await exists(destination) ? await treeHash(destination) : null;
    const owner = owners[name];
    const preserve = keepSkills && destinationHash !== null;
    if (!preserve && destinationHash && destinationHash !== sourceHash && (owner?.pluginId !== plugin.id || owner.hash !== destinationHash)) {
      throw new Error(`skill ${name} 存在未归属或本机修改，已停止安装；原目录未覆盖。`);
    }
    skills.push({ name, pluginId: plugin.id, source, destination, sourceHash, existed: destinationHash !== null, preserve, changed: !preserve && destinationHash !== sourceHash });
  }
  const dsh = process.env.DSH_BIN || 'dsh';
  console.log(`profile: ${profile}\n${plugins.map(p => `${p.id}: ${p.manifest.name} -> ${p.directory}`).join('\n')}`);
  if (dryRun) { console.log('dry-run：没有构建、安装或修改配置。'); return; }
  if (!skipBuild) {
    if (!await exists(path.join(repositoryRoot, 'node_modules', '.bin', 'tsc'))) {
      run('npm', ['ci', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: repositoryRoot });
    }
    for (const plugin of plugins) runPluginScript(plugin, 'build');
  }
  await checkPlugins({ built: true, ids: plugins.map(plugin => plugin.id) });
  const backup = path.join(dshHome, 'plugin-backups', `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.mkdir(profileDir, { recursive: true });
  const files = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml'];
  const present = {};
  for (const file of files) {
    present[file] = await exists(path.join(profileDir, file));
    if (present[file]) await fs.copyFile(path.join(profileDir, file), path.join(backup, file));
  }
  const hadOwners = await exists(ownersFile);
  if (hadOwners) await fs.copyFile(ownersFile, path.join(backup, 'skill-owners.json'));
  for (const skill of skills) if (skill.existed && skill.changed) await fs.cp(skill.destination, path.join(backup, 'skills', skill.name), { recursive: true });
  await writeJSON(path.join(backup, 'receipt.json'), { profile, plugins: plugins.map(p => p.id), present, skills, hadOwners });
  async function restoreFiles() {
    for (const file of files) {
      const target = path.join(profileDir, file);
      if (present[file]) await fs.copyFile(path.join(backup, file), target);
      else await fs.rm(target, { force: true });
    }
  }
  try {
    run(dsh, ['plugin', '--profile', profile, 'add', ...plugins.map(p => p.directory)]);
    const manifestFile = path.join(profileDir, 'package.json');
    const manifest = await readJSON(manifestFile, { name: `dsh-profile-${profile}`, private: true });
    manifest.dsh ??= {};
    manifest.dsh.profile ??= {};
    manifest.dsh.profile.bundles = [...new Set([...(manifest.dsh.profile.bundles || []), ...plugins.map(p => p.manifest.name)])];
    await writeJSON(manifestFile, manifest);
    await fs.mkdir(skillsDir, { recursive: true });
    for (const skill of skills) {
      if (skill.preserve) { console.log(`保留已有 skill：${skill.name}`); continue; }
      if (skill.changed) {
        await fs.rm(skill.destination, { recursive: true, force: true });
        await fs.cp(skill.source, skill.destination, { recursive: true });
      }
      owners[skill.name] = { pluginId: skill.pluginId, hash: skill.sourceHash };
    }
    await writeJSON(ownersFile, owners);
    console.log(`安装成功：${plugins.map(p => p.id).join(', ')}。备份：${backup}\n完全退出并重启 DSH 后加载新路径。`);
  } catch (error) {
    await restoreFiles();
    for (const skill of skills.filter(s => s.changed)) {
      await fs.rm(skill.destination, { recursive: true, force: true });
      if (skill.existed) await fs.cp(path.join(backup, 'skills', skill.name), skill.destination, { recursive: true });
    }
    if (hadOwners) await fs.copyFile(path.join(backup, 'skill-owners.json'), ownersFile);
    else await fs.rm(ownersFile, { force: true });
    if (present['package.json']) {
      try { run(dsh, ['plugin', '--profile', profile, 'install', '--offline', '--ignore-scripts']); }
      catch (rollbackError) { console.error(`恢复依赖链接失败：${rollbackError.message}。原配置备份：${backup}`); }
      await restoreFiles();
    }
    throw new Error(`安装失败，配置与 skills 已恢复：${error.message}。备份：${backup}`);
  }
}

install().catch(error => { console.error(error.message); process.exitCode = 1; });
