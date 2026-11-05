// Runs the installed DSH Web workspace, its real sidebar, and the plugin against a disposable HOME.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-dsh-calendar-'));
const home = path.join(temporary, 'home');
await fs.mkdir(home);
const env = { ...process.env, HOME: home, DSH_HOME: path.join(temporary, 'dsh') };
const profile = 'calendar-acceptance';
const root = fileURLToPath(new URL('../../../', import.meta.url));
let child, browser;
function invoke(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, timeout: 180000, stdio: 'pipe' });
  if (result.error || result.status !== 0)
    throw Error(command + ' 未能准备隔离 profile，退出码 ' + result.status);
}
try {
  invoke('dsh', ['--profile', profile, '--from-default-profile', 'web', '--dump-config']);
  invoke('./install.sh', ['--plugin', 'okr-schedule', '--profile', profile]);
  child = spawn('dsh', ['--profile', profile, '--no-open', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(Error('DSH 启动超时')), 40000);
    const capture = (chunk) => {
      buffer += chunk.toString();
      const url = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
      if (url) {
        clearTimeout(timeout);
        resolve(url[0]);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(Error('DSH 进程已退出'));
    });
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1550, height: 960 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  await welcome.click();
  const signin = page.getByRole('dialog').filter({ hasText: '开始使用' });
  await signin.getByRole('button', { name: '关闭' }).click();
  await signin.waitFor({ state: 'hidden' });
  const entry = page.getByRole('button', { name: '目标日程', exact: true });
  const panel = page.locator('iframe[title="目标日程工作区"]');
  const frame = panel.contentFrame();
  const enter = async () => {
    await entry.click();
    await frame.getByRole('heading', { name: '日程总览', exact: true }).waitFor();
  };
  const leave = async () => {
    await frame.getByRole('button', { name: '返回 DSH', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
  };
  await enter();
  assert.equal(await frame.locator('[aria-label="月视图"]').getAttribute('aria-pressed'), 'true');
  assert.equal(
    await frame
      .locator('#surface')
      .evaluate((el) => getComputedStyle(el).backgroundImage.includes('248, 250, 252')),
    true,
  );
  const scale = frame.getByRole('combobox', { name: '插件显示比例' });
  for (const zoom of ['0.8', '0.9', '1', '1.1', '1.25']) {
    await scale.selectOption(zoom);
    assert.equal(await frame.locator('#surface').evaluate((el) => getComputedStyle(el).zoom), zoom);
  }
  await scale.selectOption('1');
  const separator = frame.getByRole('separator');
  const width = Number(await separator.getAttribute('aria-valuenow'));
  await separator.press('ArrowLeft');
  assert.ok(Number(await separator.getAttribute('aria-valuenow')) > width);
  await frame.locator('#assistant-input').fill('待选汉字');
  await frame
    .locator('#assistant-input')
    .dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  assert.equal(await frame.locator('#assistant-input').inputValue(), '待选汉字');
  assert.equal(await frame.locator('#chatlog article').count(), 0);
  await page.setViewportSize({ width: 740, height: 800 });
  await frame.getByRole('button', { name: '打开助手' }).waitFor();
  await frame.getByRole('button', { name: '打开助手' }).click();
  assert.equal(await frame.locator('.assistant').evaluate((el) => getComputedStyle(el).position), 'absolute');
  await frame.locator('#assistant-input').press('Escape');
  await page.setViewportSize({ width: 1550, height: 960 });
  await leave();
  await enter();
  await frame.locator('.top [data-act=create]').click();
  await frame.getByRole('button', { name: '手工填写方案' }).click();
  await frame.locator('[data-df=name]').fill('宿主合成空间');
  await frame.locator('[data-act=add-k]').click();
  await frame.locator('[data-df=k-name]').fill('完成一次核对');
  await frame.locator('[data-df=k-standard]').fill('留下一条执行记录');
  await frame.locator('[data-act=draft-view][data-v=events]').click();
  await frame.locator('[data-act=add-draft-event]').click();
  await frame.locator('[data-df=e-title]').fill('首批日程');
  await frame.getByRole('button', { name: '确定创建', exact: true }).click();
  await frame.locator('.spacehead').filter({ hasText: '宿主合成空间' }).waitFor();
  await leave();
  await enter();
  await frame.locator('.goal-open').filter({ hasText: '宿主合成空间' }).waitFor();
  await frame.locator('.top [data-act=create]').click();
  await leave();
  await enter();
  assert.equal(await frame.locator('.goal-open').count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS installed DSH Web sidebar → calendar → creator → confirmed space; return from all three pages; re-entry, five zoom levels, narrow assistant, keyboard resize and IME.',
  );
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
