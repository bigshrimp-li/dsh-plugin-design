/**
 * 四个工具的端到端自测：用安装目录里真实的 `defineTool`，对 fixture 跑通正常路径与错误路径。
 *
 * 需要 Electron 的 Node（`defineTool` 在 app.asar 里）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals test/run.mjs
 * 或直接用 ./test.sh。
 */
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ASAR_NM = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@deepseek-ai/dsh-tools') {
      return { url: pathToFileURL(`${ASAR_NM}/dsh-tools/lib/index.js`).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

// ---- harness ----
let pass = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** PNG 尺寸：直接读 IHDR，不依赖任何图像库。 */
async function pngSize(file) {
  const buf = await readFile(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const plugin = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);
const registered = [];
plugin.apply({ tools: { register: (t) => registered.push(t) } });

console.log('插件导出');
check('name = design-tools', plugin.name === 'design-tools', plugin.name);
check('inject = [tools]', JSON.stringify(plugin.inject) === '["tools"]', JSON.stringify(plugin.inject));
check(
  '注册了四个工具',
  ['design_check', 'design_import_asset', 'design_system_check', 'design_system_import_asset'].every((n) =>
    registered.some((t) => t.name === n),
  ),
  registered.map((t) => t.name).join(','),
);

// ---- fixtures in a scratch dir ----
const dir = await mkdtemp(path.join(tmpdir(), 'dsh-design-test-'));
for (const f of ['good', 'bad', 'ds-good', 'ds-bad']) await cp(path.join(HERE, f), path.join(dir, f), { recursive: true });
await writeFile(path.join(dir, 'hero.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
await writeFile(path.join(dir, 'font.woff2'), Buffer.from('wOF2abcdef'));
await writeFile(path.join(dir, 'notes.txt'), 'not an asset');

const exec = { agent: { session: { header: { cwd: dir } } }, signal: AbortSignal.timeout(10_000) };
const call = async (name, args) => {
  const tool = registered.find((t) => t.name === name);
  try {
    return { value: await tool.execute(args, exec) };
  } catch (error) {
    return { error: error.message };
  }
};

// ---- design_check ----
console.log('\ndesign_check');
{
  const { value } = await call('design_check', { path: 'good' });
  check('合法设计稿 0 问题', value?.problems === 0, JSON.stringify(value?.issues));
  check('返回 title', value?.title === 'Spring Menu Poster', value?.title);
  check('返回 boardCount', value?.boardCount === 1, String(value?.boardCount));
  check('声明未检查项', typeof value?.notChecked === 'string' && value.notChecked.length > 0);
}
{
  const { value } = await call('design_check', { path: 'bad' });
  const msgs = (value?.issues ?? []).map((i) => i.message).join('\n');
  check('坏设计稿有问题', (value?.problems ?? 0) >= 8, String(value?.problems));
  check('抓到画板尺寸越界', /40 to 8000/.test(msgs));
  check('抓到画板文件缺失', /does not exist/.test(msgs));
  check('抓到 support.js 头行被改', /exact line <script src="\.\/support\.js">/.test(msgs));
  check('抓到属性没加引号', /not quoted/.test(msgs));
  check('抓到 data: URI', /data: URI/.test(msgs));
  check('抓到表达式 hole', /is an expression/.test(msgs));
  check('抓到非法 data-props', /data-props is not valid JSON/.test(msgs));
  check('抓到脚本拼界面', /builds UI from script/.test(msgs));
  check('抓到 iframe', /<iframe> is not allowed/.test(msgs));
  check('列出文件相对路径', (value?.issues ?? []).every((i) => typeof i.file === 'string' && i.file.length > 0));
}

// ---- design_system_check ----
console.log('\ndesign_system_check');
{
  const { value } = await call('design_system_check', { path: 'ds-good' });
  check('合法设计系统 0 问题', value?.problems === 0, JSON.stringify(value?.issues));
  check('返回 namespace', value?.namespace === 'Acme', String(value?.namespace));
  check('列出 notChecked', Array.isArray(value?.notChecked) === false && typeof value?.notChecked === 'string');
}
{
  const { value } = await call('design_system_check', { path: 'ds-bad' });
  const msgs = (value?.issues ?? []).map((i) => i.message).join('\n');
  check('坏设计系统有问题', (value?.problems ?? 0) >= 3, String(value?.problems));
  check('抓到缺 marker', /no createdOnFiles or convertedFrom marker/.test(msgs));
  check('抓到非法 namespace', /must be the bundle's global/.test(msgs));
  check('抓到 map 形状的 tokens', /no "tokens" list/.test(msgs));
  check('抓到非法 token 名', /bad or duplicate name/.test(msgs));
}

// ---- design_import_asset ----
console.log('\ndesign_import_asset');
{
  const { value } = await call('design_import_asset', { canvas: 'good', path: 'hero.png' });
  check('返回 /_blob/<id>', /^\/_blob\/[0-9a-f]{32}$/.test(value?.src ?? ''), value?.src);
  check('返回 content-type', value?.contentType === 'image/png', value?.contentType);
  const again = await call('design_import_asset', { canvas: 'good', path: 'hero.png' });
  check('按内容寻址去重', again.value?.src === value?.src);
  const font = await call('design_import_asset', { canvas: 'good', path: 'font.woff2' });
  check('字体走 @font-face 提示', /@font-face/.test(font.value?.next ?? ''));
  const assets = await readdir(path.join(dir, 'good/assets'));
  check('落进 <canvas>/assets/', assets.some((f) => f.endsWith('.png')) && assets.includes('index.json'), assets.join(','));
  const index = JSON.parse(await readFile(path.join(dir, 'good/assets/index.json'), 'utf8'));
  check('维护 index.json', Object.keys(index).length === 2, JSON.stringify(index));
}
check('拒绝非素材类型', /只能导入/.test((await call('design_import_asset', { canvas: 'good', path: 'notes.txt' })).error ?? ''));
check('拒绝不存在的文件', /没有这个文件/.test((await call('design_import_asset', { canvas: 'good', path: 'nope.png' })).error ?? ''));
check('拒绝不是设计稿的目录', /还不是设计稿/.test((await call('design_import_asset', { canvas: 'ds-good', path: 'hero.png' })).error ?? ''));
check('拒绝 .. 越界', /工作目录里的目录/.test((await call('design_import_asset', { canvas: '../etc', path: 'hero.png' })).error ?? ''));
check('拒绝绝对路径', /工作目录里的文件/.test((await call('design_import_asset', { canvas: 'good', path: '/etc/hosts' })).error ?? ''));

// ---- design_system_import_asset ----
console.log('\ndesign_system_import_asset');
{
  const { value } = await call('design_system_import_asset', { system: 'ds-good', path: 'hero.png', group: 'Logos' });
  check('返回 record', value?.record?.blob?.length === 32 && value?.record?.type === 'image/png', JSON.stringify(value?.record));
  check('组里落到 assets/<组>/', value?.restoredAs === 'assets/Logos/hero.png', value?.restoredAs);
  check('indexPath 指向 assetGroups', JSON.stringify(value?.indexPath) === '["assetGroups","Logos","files","hero.png"]', JSON.stringify(value?.indexPath));
  const { value: font } = await call('design_system_import_asset', { system: 'ds-good', path: 'font.woff2' });
  check('不给 group 时字体落到 fonts/', font?.restoredAs === 'fonts/font.woff2', font?.restoredAs);
  check('indexPath 指向 blobs', JSON.stringify(font?.indexPath) === '["blobs","fonts/font.woff2"]', JSON.stringify(font?.indexPath));
  const blobs = await readdir(path.join(dir, 'ds-good/_blobs'));
  check('落进 <system>/_blobs/', blobs.filter((f) => f !== 'index.json').length === 2, blobs.join(','));
}
check('拒绝非法组名', /素材组的文件夹名/.test((await call('design_system_import_asset', { system: 'ds-good', path: 'hero.png', group: 'bad/group' })).error ?? ''));
check('拒绝没有 marker 的设计系统', /不是带 createdOnFiles 或 convertedFrom 标记/.test((await call('design_system_import_asset', { system: 'ds-bad', path: 'hero.png' })).error ?? ''));

// ---- design_render ----
console.log('\ndesign_render');
{
  const tool = registered.find((t) => t.name === 'design_render');
  check('注册了 design_render', tool !== undefined);
  try {
    // 渲染要起浏览器，比校验慢得多：给它自己的、更长的取消预算。
    const renderExec = { ...exec, signal: AbortSignal.timeout(180_000) };
    const value = await tool.execute({ path: 'good' }, renderExec);
    const b = value.rendered?.[0];
    check('渲染出一块画板', value.rendered?.length === 1, JSON.stringify(value?.rendered));
    check('画板挂载起来了', b?.mounted === true, JSON.stringify(b));
    check('没有超出 frame', b?.overflow === false, `声明 ${b?.declared}，实际 ${b?.rendered}`);
    check('没有页面报错', (b?.errors ?? []).length === 0, JSON.stringify(b?.errors));
    check('写出 PNG', (b?.pngBytes ?? 0) > 1000, String(b?.pngBytes));
    check('PNG 真在磁盘上', (await stat(b.png)).size === b.pngBytes, b?.png);
    check('PNG 尺寸 = frame × scale', await pngSize(b.png).then((s) => s.w === 880 * 2 && s.h === 560 * 2), JSON.stringify(await pngSize(b.png)));
  } catch (error) {
    check('渲染（本机没有 Chrome 时跳过）', /找不到无头浏览器/.test(error.message), error.message);
  }
}

// ---- design_export ----
console.log('\ndesign_export');
{
  const tool = registered.find((t) => t.name === 'design_export');
  check('注册了 design_export', tool !== undefined);
  const value = await tool.execute({ path: 'good' }, { ...exec, signal: AbortSignal.timeout(120_000) });
  const f = value.files?.[0];
  check('导出一个 HTML', value.files?.length === 1, JSON.stringify(value.files));
  check('文件在磁盘上', (await stat(f.html)).size === f.bytes, f?.html);
  const html = await readFile(f.html, 'utf8');
  check('不再指向 ./support.js', !html.includes('src="./support.js"'), '仍然是外部引用');
  check('运行时整段内联（>1MB）', html.length > 1_000_000, `${html.length} 字节`);
  // $& 事故：字符串形式的 replace 会把 $& 展开成整个匹配，把运行时改坏
  check('运行时没有被 $& 替换事故改坏', !html.includes('src="./support.js"></script>/'), '脚本里又出现了 support.js 那一行');
  check('记录了内联了什么', (f.notes ?? []).length > 0, JSON.stringify(f?.notes));
}

// ---- design_export：画板间链接改写 ----
console.log('\ndesign_export 链接');
{
  const canvas = path.join(dir, 'linked');
  await mkdir(canvas, { recursive: true });
  await writeFile(path.join(canvas, 'canvas.json'), JSON.stringify({
    v: 3,
    createdOnFiles: { v: 1, at: '2026-01-01T00:00:00Z' },
    title: 'Linked',
    boards: {
      'Main.dc.html': { x: 0, y: 0, w: 400, h: 300 },
      'Second.dc.html': { x: 480, y: 0, w: 400, h: 300 },
    },
    order: ['Main.dc.html', 'Second.dc.html'],
    notes: {},
    designSystems: [],
  }, null, 2));
  const board = (title, href) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<div style="width: 400px; height: 300px"><a href="${href}">Go</a></div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":400,"height":300}}'>
class Component extends DCLogic {
renderVals() { return {}; }
}
</script>
</body>
</html>
`;
  await writeFile(path.join(canvas, 'Main.dc.html'), board('Main', 'Second.dc.html'));
  await writeFile(path.join(canvas, 'Second.dc.html'), board('Second', 'Main.dc.html'));

  const tool = registered.find((t) => t.name === 'design_export');
  const value = await tool.execute({ path: 'linked' }, { ...exec, signal: AbortSignal.timeout(60_000) });
  check('导出两块画板', value.files?.length === 2, JSON.stringify(value.files?.map((f) => f.board)));
  const main = await readFile(value.files[0].html, 'utf8');
  check('画板间链接指向导出后的文件名', main.includes('href="Second.html"') && !main.includes('Second.dc.html'), '仍然是 .dc.html');
  check('说明里记了链接改写', (value.files[0].notes ?? []).some((n) => /链接/.test(n)), JSON.stringify(value.files[0].notes));
  await rm(canvas, { recursive: true, force: true });
}

// ---- 编辑器的源码映射（tid ↔ 源码位置）----
console.log('\n编辑器 · 源码映射');
{
  const { listElements, setInlineStyle, setText, elementAt } =
    await import(pathToFileURL(path.join(ROOT, 'dist/editor/source.js')).href);
  const src = await readFile(path.join(ROOT, 'examples/order-flow/Main.dc.html'), 'utf8');
  const els = listElements(src);

  check('解析出元素并按 tid 编号', els.length > 20 && els[0].tag === 'helmet', `${els.length} 个，第一个是 ${els[0]?.tag}`);
  check('helmet 的 link/style 是 1/2，根 div 是 3',
    els[1]?.tag === 'link' && els[2]?.tag === 'style' && els[3]?.tag === 'div',
    els.slice(0, 4).map((e) => e.tid + ':' + e.tag).join(' '));

  const h1 = els.find((e) => e.tag === 'h1');
  const edited = setInlineStyle(src, h1.tid, h1.style.replace('30px', '44px'));
  check('改一条声明写回源码', edited.includes('font-size: 44px') && edited !== src);
  check('没动过的声明按原样保留（不被 CSSOM 规范化）', edited.includes('margin: 8px 0 0'), '出现了 8px 0px 0px 之类的规范化');
  check('设回原值即字节复原', setInlineStyle(edited, h1.tid, h1.style) === src);
  check('去掉 style 属性后仍是合法结构', elementAt(setInlineStyle(src, h1.tid, ''), h1.tid).style === '');

  const withText = setText(src, h1.tid, 'Coffee & tea <today>');
  check('改文字会转义 HTML', withText.includes('Coffee &amp; tea &lt;today&gt;'));

  const container = els.find((e) => !e.isVoid && !e.selfClosing && /<[A-Za-z]/.test(src.slice(e.inner[0], e.inner[1])));
  let refused = false;
  try { setText(src, container.tid, 'x'); } catch { refused = true; }
  check('有子元素时拒绝原地改字', refused, `<${container.tag}> 应该被拒绝`);

  let holeRefused = false;
  try { setText('x<x-dc>\n<p>{{ title }}</p>\n</x-dc>', 0, 'x'); } catch { holeRefused = true; }
  check('内容是 {{…}} 绑定时拒绝原地改字', holeRefused);
}

// ---- 编辑器服务 ----
console.log('\n编辑器 · 服务');
{
  const { startEditor } = await import(pathToFileURL(path.join(ROOT, 'dist/editor/server.js')).href);
  const ws = path.join(dir, 'editor');
  await mkdir(ws, { recursive: true });
  await cp(path.join(ROOT, 'examples/order-flow'), path.join(ws, 'order-flow'), { recursive: true });
  const file = path.join(ws, 'order-flow/Main.dc.html');
  const before = await readFile(file, 'utf8');

  const ed = await startEditor({ workspaceDir: ws });
  try {
    const list = await (await fetch(new URL('/api/workspace', ed.url))).json();
    check('发现工作目录下的设计稿', list.canvases?.length === 1 && list.canvases[0].path === 'order-flow', JSON.stringify(list.canvases));

    const board = await (await fetch(new URL('/api/board?canvas=order-flow&board=Main.dc.html', ed.url))).json();
    check('读出画板与元素表', board.elements?.length > 20 && board.declared?.w === 390);

    const h1 = board.elements.find((e) => e.tag === 'h1');
    const editRes = await fetch(new URL('/api/edit', ed.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas: 'order-flow', board: 'Main.dc.html', tid: h1.tid, style: 'font-size: 44px' }),
    });
    check('写入成功', editRes.status === 200, `HTTP ${editRes.status}`);
    check('源码真的变了', (await readFile(file, 'utf8')).includes('font-size: 44px'));

    const undoRes = await fetch(new URL('/api/undo', ed.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas: 'order-flow', board: 'Main.dc.html' }),
    });
    check('撤销成功', (await undoRes.json()).changed === true);
    check('撤销后字节复原', (await readFile(file, 'utf8')) === before);

    // 有子元素的节点不能原地改字（tid 3 是画板根 div）
    const badRes = await fetch(new URL('/api/edit', ed.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas: 'order-flow', board: 'Main.dc.html', tid: 3, text: 'x' }),
    });
    check('改有子元素的节点被拒绝', badRes.status === 409 || badRes.status === 422, `HTTP ${badRes.status}`);
    check('被拒绝后文件没被动过', (await readFile(file, 'utf8')) === before);

    // 纯文字节点则可以
    const okText = await fetch(new URL('/api/edit', ed.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas: 'order-flow', board: 'Main.dc.html', tid: h1.tid, text: 'Choose your drink' }),
    });
    check('纯文字节点可以原地改字', okText.status === 200 && (await readFile(file, 'utf8')).includes('Choose your drink'));
    await fetch(new URL('/api/undo', ed.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas: 'order-flow', board: 'Main.dc.html' }),
    });
    check('改字也能撤销', (await readFile(file, 'utf8')) === before);

    // 路径逃逸
    const esc = await fetch(new URL('/api/board?canvas=..&board=../../etc/passwd', ed.url));
    check('挡住路径逃逸', esc.status >= 400, `HTTP ${esc.status}`);
  } finally {
    await ed.close();
  }
  await rm(ws, { recursive: true, force: true });
}

await rm(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
