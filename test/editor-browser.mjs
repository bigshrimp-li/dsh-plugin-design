// Headless browser regressions against the actual editor and canvas runtime.
// DSH_DESIGN_PLAYWRIGHT may point to an existing playwright-core installation.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startEditor } from '../dist/editor/server.js';
import { findChrome } from '../dist/render.js';

const { chromium } = await import(process.env.DSH_DESIGN_PLAYWRIGHT
  ? pathToFileURL(process.env.DSH_DESIGN_PLAYWRIGHT).href : 'playwright-core');
const browser = await chromium.launch({ executablePath: await findChrome(), headless: true });
const results = [];
const fixture = fileURLToPath(new URL('./editor-fixtures/simple-ui', import.meta.url));
const output = process.env.DSH_DESIGN_TEST_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const pause = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));
async function run(name, action) {
  if (process.env.DSH_DESIGN_TEST_FILTER && !name.includes(process.env.DSH_DESIGN_TEST_FILTER)) return;
  const workspace = await mkdtemp(path.join(tmpdir(), 'design-browser-'));
  await cp(fixture, path.join(workspace, 'simple-ui'), { recursive: true });
  const server = await startEditor({ workspaceDir: workspace });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const file = board => path.join(workspace, 'simple-ui', board + '.dc.html');
  const saved = board => readFile(file(board), 'utf8');
  const api = async (route, body) => {
    const res = await fetch(new URL(route, server.url), body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    return { status: res.status, body: await res.json() };
  };
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('#board').contentWindow.__designEditor?.ready === true);
    await pause(180); // host registers the source map on its 100ms readiness poll
    return page.frames().find(f => f.url().includes('/board/'));
  };
  const board = async name => {
    await page.locator('#boards button', { hasText: { Profile: 'Profile card', Layout: 'Layout controls', List: 'Repeated list' }[name] }).click();
    await page.waitForFunction(name => document.querySelector('#board').contentWindow.location.pathname.endsWith(name + '.dc.html'), name);
    return ready();
  };
  const field = prop => page.locator(`input[data-prop="${prop}"]`);
  const drag = async (locator, dx, dy) => {
    const b = await locator.boundingBox();
    assert.ok(b);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
    await pause();
  };
  try {
    await page.goto(server.url);
    await page.locator('#zoom').selectOption('1');
    const frame = await ready();
    await action({ page, frame, board, ready, saved, file, api, field, drag });
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    if (output) await page.screenshot({ path: path.join(output, name + '.png') });
    console.log('PASS', name);
    results.push({ name, status: 'PASS' });
  } catch (error) {
    console.log('FAIL', name, error.message);
    results.push({ name, status: 'FAIL', error: error.message });
    if (output) await page.screenshot({ path: path.join(output, name + '.png') }).catch(() => {});
  } finally {
    await context.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

try {
  await run('01-edit-versus-browse', async ({ page, frame }) => {
    await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').innerText(), '0', 'editing must not activate the button');
    await page.locator('#mode').click();
    await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').innerText(), '1', 'browsing must activate the button');
  });
  await run('02-rapid-properties', async ({ frame, field, saved }) => {
    await frame.locator('#heading').click();
    await field('font-size').fill('36px');
    await field('color').fill('#cc3311');
    await pause();
    const source = await saved('Profile');
    assert.match(source, /font-size: 36px/);
    assert.match(source, /color: #cc3311/);
  });
  await run('03-switch-element', async ({ frame, field, saved }) => {
    await frame.locator('#heading').click();
    await field('font-size').fill('36px');
    await frame.locator('#subtitle').click();
    await field('color').fill('#cc3311');
    await pause();
    assert.match(await saved('Profile'), /font-size: 36px/);
  });
  await run('04-switch-board-pending-save', async ({ frame, field, board, saved }) => {
    const original = await saved('Layout');
    await frame.locator('#heading').click();
    await field('font-size').fill('36px');
    await board('Layout');
    await pause();
    assert.match(await saved('Profile'), /font-size: 36px/);
    assert.equal(await saved('Layout'), original, 'must not write the old selection into another board');
  });
  await run('05-reselect-inspector', async ({ page, frame }) => {
    await frame.locator('#heading').click();
    await page.keyboard.press('Escape');
    await frame.locator('#heading').click();
    assert.equal(await page.locator('input[data-prop="font-size"]').count(), 1);
  });
  await run('06-text-escape-save', async ({ page, frame, saved }) => {
    await frame.locator('#literal').click();
    await page.locator('#textBtn').click();
    await frame.locator('#literal').fill('Changed with Escape');
    await page.keyboard.press('Escape');
    await pause();
    assert.match(await saved('Profile'), /Changed with Escape/);
  });
  await run('07-text-blur-save', async ({ page, frame, saved }) => {
    await frame.locator('#literal').click();
    await page.locator('#textBtn').click();
    await frame.locator('#literal').fill('Changed by blur');
    await page.locator('.brand').click();
    await pause();
    assert.match(await saved('Profile'), /Changed by blur/);
  });
  await run('08-drag-visible-and-cumulative', async ({ board, drag, saved }) => {
    const frame = await board('Layout');
    const box = frame.locator('#moving');
    const before = await box.boundingBox();
    await drag(box, 30, 10);
    const once = await box.boundingBox();
    assert.ok(Math.abs(once.x - before.x - 30) < 2, 'mouse release must retain the visible position');
    await drag(box, 20, 10);
    const twice = await box.boundingBox();
    assert.ok(Math.abs(twice.x - before.x - 50) < 2, 'successive drags must accumulate');
    assert.match(await saved('Layout'), /translate/);
  });
  await run('09-content-box-west-resize', async ({ board, drag }) => {
    const frame = await board('Layout');
    await frame.locator('#absolute').click();
    const before = await frame.locator('#absolute').boundingBox();
    await drag(frame.locator('[data-handle="7"]'), -20, 0);
    const after = await frame.locator('#absolute').boundingBox();
    assert.ok(Math.abs(after.width - before.width - 20) < 2, 'resize must account for border and padding');
    assert.ok(Math.abs(after.x + after.width - before.x - before.width) < 2, 'opposite edge must remain fixed');
  });
  await run('10-repeat-selection-and-preview', async ({ board, field }) => {
    const frame = await board('List');
    await frame.locator('.item').nth(1).click();
    const selectedY = await frame.evaluate(() => document.querySelector('[data-dc-editor="label"]').style.top);
    const secondY = await frame.locator('.item').nth(1).evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(parseFloat(selectedY) - secondY) < 40, 'selection must target the clicked instance');
    await field('border-radius').fill('16px');
    await pause();
    assert.deepEqual(await frame.locator('.item').evaluateAll(els => els.map(el => getComputedStyle(el).borderRadius)), ['16px','16px','16px']);
  });
  await run('11-bound-text-refused', async ({ page, board }) => {
    const frame = await board('List');
    await frame.locator('.item').nth(1).click();
    await page.locator('#textBtn').click();
    assert.equal(await frame.locator('[contenteditable]').count(), 0, 'resolved binding must not be treated as literal text');
    assert.match(await page.locator('#toast').innerText(), /绑定/);
  });
  await run('12-external-change-conflict', async ({ file, api }) => {
    const snapshot = await api('/api/board?canvas=simple-ui&board=Profile.dc.html');
    const heading = snapshot.body.elements.find(e => e.tag === 'h1');
    const changed = snapshot.body.source.replace('Profile card</h1>', 'Changed externally</h1>');
    await writeFile(file('Profile'), changed);
    const res = await api('/api/edit', { canvas: 'simple-ui', board: 'Profile.dc.html', tid: heading.tid, style: 'color: red', revision: snapshot.body.revision });
    assert.equal(res.status, 409, 'stale selection must be rejected before writing');
    assert.equal(await readFile(file('Profile'), 'utf8'), changed);
  });
  await run('13-undo-pending-save', async ({ page, frame, field, saved, ready }) => {
    const original = await saved('Profile');
    await frame.locator('#heading').click();
    await field('font-size').fill('36px');
    await pause();
    await field('color').fill('#cc3311');
    await page.locator('#undo').click();
    await ready();
    assert.match(await saved('Profile'), /font-size: 36px/);
    assert.doesNotMatch(await saved('Profile'), /color: #cc3311/);
    await page.locator('#undo').click();
    await ready();
    assert.equal(await saved('Profile'), original);
  });
  await run('14-slow-save-new-input', async ({ page, frame, field, saved }) => {
    await page.route('**/api/edit', async route => { await pause(850); await route.continue(); });
    await frame.locator('#heading').click();
    await field('font-size').fill('36px');
    await pause(520);
    await field('color').fill('#cc3311');
    await page.waitForFunction(() => document.querySelector('#saveState').textContent === '已保存');
    assert.match(await saved('Profile'), /font-size: 36px/);
    assert.match(await saved('Profile'), /color: #cc3311/);
    assert.equal(await frame.locator('#heading').evaluate(el => getComputedStyle(el).fontSize), '36px');
    assert.equal(await frame.locator('#heading').evaluate(el => getComputedStyle(el).color), 'rgb(204, 51, 17)');
  });
  await run('15-link-navigation-target', async ({ page, frame, ready, field, saved }) => {
    const original = await saved('Profile');
    await page.locator('#mode').click();
    await frame.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#board').contentWindow.location.pathname.endsWith('Layout.dc.html'));
    const next = await ready();
    assert.equal(await page.locator('#boards [aria-selected="true"]').innerText(), 'Layout controls');
    await page.locator('#mode').click();
    await next.locator('#heading').click();
    await field('font-size').fill('38px');
    await pause();
    assert.equal(await saved('Profile'), original);
    assert.match(await saved('Layout'), /font-size: 38px/);
  });
  await run('16-quoted-font-family', async ({ frame, field, saved }) => {
    await frame.locator('#heading').click();
    await field('font-family').fill('"Arial", sans-serif');
    await pause();
    assert.match(await saved('Profile'), /&quot;Arial&quot;, sans-serif/);
    assert.equal(await frame.locator('#heading').evaluate(el => getComputedStyle(el).fontFamily), 'Arial, sans-serif');
  });
  await run('17-conflict-cancels-queued-edits', async ({ page, frame, field, saved, file }) => {
    await page.route('**/api/edit', async route => { await pause(700); await route.continue(); });
    await frame.locator('#heading').click();
    await field('font-size').fill('36px');
    await pause(500);
    const outside = (await saved('Profile')).replace('Profile card</h1>', 'Changed outside</h1>');
    await writeFile(file('Profile'), outside);
    await frame.locator('#subtitle').click();
    await field('color').fill('#cc3311');
    await pause(2200);
    assert.equal(await saved('Profile'), outside);
    assert.equal(await page.locator('#saveState').innerText(), '保存失败，请重试');
  });
  await run('18-narrow-sidebar-fit', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 850 });
    await page.locator('#zoom').selectOption('fit');
    await pause(150);
    const b = await page.locator('#board').boundingBox();
    const wrap = await page.locator('#canvaswrap').boundingBox();
    assert.ok(b.width > 100 && b.width < wrap.width, 'canvas stays visible at sidebar width');
    assert.ok(b.x >= wrap.x && b.x + b.width <= wrap.x + wrap.width + 1);
  });
  await run('19-right-anchored-drag', async ({ board, drag }) => {
    const frame = await board('Layout');
    const box = frame.locator('#anchored');
    const before = await box.boundingBox();
    await drag(box, -20, 10);
    const after = await box.boundingBox();
    assert.ok(Math.abs(after.x - before.x + 20) < 2);
    assert.ok(Math.abs(after.y - before.y - 10) < 2);
  });
  await run('20-invalid-css-not-saved', async ({ frame, field, saved }) => {
    const original = await saved('Profile');
    await frame.locator('#heading').click();
    await field('font-size').fill('not-a-size');
    await pause();
    assert.equal(await field('font-size').getAttribute('aria-invalid'), 'true');
    assert.equal(await saved('Profile'), original);
  });
  await run('21-inspector-refresh-after-undo', async ({ page, frame, field, ready }) => {
    await frame.locator('#literal').click();
    const initialBox = await page.locator('[data-box]').innerText();
    await field('font-size').fill('24px');
    await pause();
    assert.equal(await page.locator('[data-computed="font-size"]').inputValue(), '24px');
    assert.notEqual(await page.locator('[data-box]').innerText(), initialBox);
    await page.locator('#undo').click();
    await ready();
    assert.equal(await page.locator('[data-computed="font-size"]').inputValue(), '16px');
    assert.equal(await page.locator('[data-box]').innerText(), initialBox);
  });
} finally {
  await browser.close();
  if (output) await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(`${results.filter(r => r.status === 'PASS').length}/${results.length} browser cases passed`);
if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
