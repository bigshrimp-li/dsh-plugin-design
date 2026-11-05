import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createPluginService } from '../src/host/service.js';
import { createHttpHandler } from '../src/host/http.js';

const pluginDirectory = fileURLToPath(new URL('..', import.meta.url));
const learningTypes = [{ id: 'material', version: 1, title: '学习资料', fields: [{ id: 'content', title: '内容', kind: 'text', required: true }, { id: 'date', title: '发生日期', kind: 'date' }] }];
const trainingTypes = [{ id: 'training', version: 1, title: '训练记录', fields: [{ id: 'distance', title: '距离', kind: 'decimal', precision: 2, unit: 'km', required: true }, { id: 'duration', title: '时长', kind: 'integer', unit: '分钟', required: true, min: 1 }, { id: 'date', title: '发生日期', kind: 'date' }] }];
const bindingFor = objectiveId => ({ objectiveId, trusted: true, userInitiated: true, sourceScope: { kind: 'private', id: objectiveId } });
function checked(receipt) { if (['failed', 'conflict'].includes(receipt.kind)) throw new Error(receipt.error?.message || 'Preview fixture failed'); return receipt.data; }

async function seedLegacyPreview(service, baseDir) {
  for (const [objectiveId, title, purpose, types] of [
    ['O_learning_demo', '学习空间（合成预览）', '维护合成资料与笔记；所有数据均可丢弃。', learningTypes],
    ['O_training_demo', '运动空间（合成预览）', '验证训练记录、缺项补充与执行，不提供真实健康建议。', trainingTypes]
  ]) checked(await service.domain.execute('space.create', { title, purpose, types, activeBundleId: 'manual-v1' }, bindingFor(objectiveId)));
  checked(await service.domain.execute('item.save', { typeId: 'material', title: '合成阅读记录', fields: { content: '这是一份本地生成的测试资料。' }, body: '仅供验证真实保存、刷新重读与修改。' }, bindingFor('O_learning_demo')));
  checked(await service.domain.execute('item.save', { typeId: 'training', title: '合成跑步记录', fields: { distance: '3.00', duration: 20, date: '2026-10-27' } }, bindingFor('O_training_demo')));
  checked(await service.domain.execute('item.save', { typeId: 'training', title: '合成待补时长', fields: { distance: '5.00' } }, bindingFor('O_training_demo')));
  const bundle = { title: '合成学习方案草稿', description: '人工编写的受限方案，用于验证实际草稿审查与试用，不代表模型生成质量。', types: learningTypes,
    tools: [{ id: 'materials', description: '记录和查询学习资料', skill: '内容完整时直接保存；缺少内容时待整理；不支持的类型不记录。', commands: {
      save: { input: { type: 'object', properties: { title: { type: 'string' }, fields: { type: 'object' }, body: { type: 'string' } } }, program: [{ op: 'save', typeId: 'material', input: { title: { ref: 'input.title' }, fields: { ref: 'input.fields' }, body: { ref: 'input.body' } } }], examples: [{ title: '合成演示样例', fields: { content: '仅供运行器试用，永不转正式。' }, body: '' }] },
      query: { input: { type: 'object', properties: {} }, program: [{ op: 'query', typeId: 'material', input: {} }], examples: [{}] }
    } }], page: [{ kind: 'table', title: '学习资料', typeId: 'material' }, { kind: 'markdown', title: '使用说明', content: '这是合成预览。资料日期可以为空，记录只有保存成功后才成为正式事项。' }] };
  checked(await service.schemes.execute('scheme.draft', { bundle }, bindingFor('O_learning_demo')));
  const legacy = path.join(baseDir, 'O_legacy_demo');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'meta.json'), JSON.stringify({ id: 'O_legacy_demo', title: '旧空间（合成迁移）' }));
  await fs.writeFile(path.join(legacy, 'schedules.json'), JSON.stringify([{ id: 'SCH_preview', title: '旧合成日程', date: '2026-10-27', status: 'pending' }]));
  await fs.writeFile(path.join(baseDir, 'global_index.json'), JSON.stringify({ objectives: [{ id: 'O_legacy_demo', title: '旧空间（合成迁移）' }] }));
}

// Synthetic examples for a human walkthrough, committed through the same Host commands as the UI.
async function seedCalendarPreview(service) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Intl.DateTimeFormat('en-CA', {year:'numeric',month:'2-digit',day:'2-digit',timeZone:timezone}).format(new Date());
  const examples = [
    ['english','学习英语','#0e7490','掌握 120 个新词','词汇复测','19:30','词汇'],
    ['reading','深度阅读','#7c3aed','完成阅读摘记','阅读与摘记','20:30','阅读'],
    ['ledger','日常记账','#0f766e','核对本月收支','核对账目','18:00','核账'],
  ];
  for (const [id,name,color,standard,title,time,kind] of examples) {
    const bookkeeping = id==='ledger';
    const goal = {name,color,about:standard,bookkeeping,assistantRule:'只根据本空间已保存的记录回答。',
      ks:[{id:'k1',name:standard,standard,from:day,to:day,kind}],
      ...(bookkeeping?{layout:{group:'month',metric:'cash',style:'cards'}}:{})};
    const {objectiveId} = checked(await service.execute('calendar.confirm',{confirm:true,draft:{id,goal,timezone,
      events:[{id:'sample',kind,title,date:day,time,duration:30}]}},{trusted:true,userInitiated:true,global:true}));
    if (bookkeeping) {
      for (const [label,category,amount,flow] of [['买菜','餐饮',12000,'expense'],['交通充值','交通',3000,'expense'],['工资','工资',600000,'income']]) {
        checked(await service.execute('calendar.ledger.save',{event:{oid:objectiveId,title:label,kind:category,date:day,time:'12:00',
          posting:{currency:'CNY',cents:amount,flow}}},bindingFor(objectiveId)));
      }
    }
  }
}

/** Starts a real plugin API against a disposable synthetic HOME; never uses the user's data. */
export async function startPreview({ port = 0, traceNavigation = false, calendarOnly = false, calendarExample = false, adapter = null } = {}) {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-synthetic-preview-'));
  const baseDir = path.join(temporaryHome, '.dsh_okr');
  let service;
  let server;
  try {
    const harness = await build({
      stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';
        const root=createRoot(document.getElementById('root'));let mainComponent;
        const showWorkbench=()=>root.render(React.createElement(mainComponent));
        const showLauncher=()=>root.render(React.createElement('main',{style:{padding:32,background:'#fff',color:'#0f172a'}},
          React.createElement('h1',null,'DSH 入口（合成预览）'),React.createElement('button',{onClick:showWorkbench},'目标日程')));
        ${traceNavigation ? `window.addEventListener('asv-open-bot-trace',event=>{event.preventDefault();const target=event.detail;root.render(React.createElement('main',{'aria-label':'合成 Trace 导航接收器'},React.createElement('h1',null,'Trace 导航验收'),React.createElement('pre',{'data-testid':'trace-target'},JSON.stringify(target)),React.createElement('button',{onClick:()=>window.dispatchEvent(new CustomEvent('asv-return-bot-trace',{detail:target.returnTarget}))},'返回原工作台')));});` : ''}
        window.__ModuleLoader__={load({factory}){const plugin=factory(name=>{if(name==='react')return React;throw new Error('Unexpected preview dependency: '+name);});plugin.apply({layout:{selectPanel(name){if(name==='okr-schedule')showWorkbench();else if(name===null)showLauncher();}},effect(callback){return callback();},slots:{inject(name,callback){callback();},register(options,component){if(options.name==='main'){mainComponent=component;showWorkbench();}return()=>{};}}});}};`, resolveDir: pluginDirectory, loader: 'js' },
      bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent'
    });
    service = createPluginService({ baseDir, adapter: adapter || { available: false, disabledReason: '合成数据预览未配置模型。已有工具连接真实临时数据库，Bot 不生成预设回复。' } });
    const capabilities = checked(await service.execute('capabilities', {}, { trusted: true, global: true }));
    if (!capabilities.sqlite) throw new Error('Preview requires the SQLite worker capability');
    if (calendarExample) await seedCalendarPreview(service);
    else if (!calendarOnly) await seedLegacyPreview(service, baseDir);
    const handler = createHttpHandler({ service });
    const clientSource = await fs.readFile(path.join(pluginDirectory, 'client.js'));
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>个人日常助手 · 合成数据预览</title><style>html,body,#root{height:100%;margin:0;background:#0b0f19}.preview-note{position:fixed;bottom:3px;left:6px;z-index:9999;background:#0c1424dd;color:#a7b6cc;border:1px solid #34425d;border-radius:4px;padding:2px 7px;font:10px/1.5 sans-serif;pointer-events:none;max-width:calc(100vw - 28px)}</style></head><body><div id="root"></div><span class="preview-note" role="note">合成数据预览 · 临时 HOME · ${adapter ? '测试模型传输' : 'Bot 未连接'}</span><script src="/harness.js"></script><script src="/client.js"></script></body></html>`;
    server = http.createServer(async (request, response) => {
      if (await handler(request, response)) return;
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/harness.js' || pathname === '/client.js') { response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(pathname === '/harness.js' ? harness.outputFiles[0].contents : clientSource); return; }
      if (pathname === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"synthetic":true,"ready":true}'); return; }
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html); return; }
      response.writeHead(404); response.end('Not found');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    let closed = false;
    return { url: `http://127.0.0.1:${server.address().port}`, temporaryHome, baseDir, service,
      async close() { if (closed) return; closed = true; server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await service.close(); await fs.rm(temporaryHome, { recursive: true, force: true }); }
    };
  } catch (error) {
    server?.closeAllConnections?.(); server?.close(); await service?.close(); await fs.rm(temporaryHome, { recursive: true, force: true }); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/preview.mjs [--port 4177] [--calendar]\nStarts a real plugin API and client with disposable synthetic data only.\nUse --calendar to open synthetic English, reading and ledger examples on the local date.\nRequires local esbuild/react/react-dom; no model or user HOME is used. Ctrl+C cleans temporary data.');
  } else {
    const flag = process.argv.indexOf('--port');
    const port = flag < 0 ? 4177 : Number(process.argv[flag + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port');
    const preview = await startPreview({ port, calendarExample:process.argv.includes('--calendar') });
    console.log(`Synthetic preview: ${preview.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { preview.close().then(() => process.exit(0)); });
  }
}
