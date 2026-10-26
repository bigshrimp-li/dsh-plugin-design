import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EditorTransactions, revisionOf } from '../dist/editor/transactions.js';
import { historyShortcut, install } from '../src/editor/assets/redo.js';

test('history shortcut respects text input, IME and platform modifiers', () => {
  const keyboard = { key: 'z', ctrlKey: true, target: {} };
  assert.equal(historyShortcut(keyboard), 'undo');
  assert.equal(historyShortcut({ ...keyboard, shiftKey: true }), 'redo');
  assert.equal(historyShortcut({ ...keyboard, key: 'y' }), 'redo');
  assert.equal(historyShortcut({ ...keyboard, ctrlKey: false, metaKey: true }), 'undo');
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { defaultPrevented: true }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }, { ctrlKey: false }, { key: 'a' }]) {
    assert.equal(historyShortcut({ ...keyboard, ...patch }), null);
  }
});

function fakeEditor(action) {
  class Button extends EventTarget {
    disabled = false;
    setAttribute() {}
    insertAdjacentElement() {}
    remove() {}
  }
  const undo = new Button();
  const buttons = {};
  const errors = [];
  const editor = {
    el: { undo }, state: { canvas: 'demo', canUndo: true, canRedo: true }, features: {}, events: new EventTarget(),
    addButton(id, label, handler) { const b = new Button(); b.addEventListener('click', handler); buttons[id] = b; return b; },
    registerShortcut(fn) { editor.shortcut = fn; return () => { editor.shortcut = null; }; },
    historyAction: action, toast: (...args) => errors.push(args),
  };
  return { editor, buttons, errors };
}

test('history UI prevents concurrent requests and shows failure without losing availability', async () => {
  let resolve;
  const calls = [];
  const { editor, buttons, errors } = fakeEditor(kind => { calls.push(kind); return new Promise(r => { resolve = r; }); });
  const feature = install(editor);
  const pending = feature.run('redo');
  assert.equal(buttons.redo.disabled, true);
  assert.equal(editor.el.undo.disabled, true);
  await feature.run('undo');
  assert.deepEqual(calls, ['redo']);
  resolve(); await pending;
  assert.equal(buttons.redo.disabled, false);
  editor.historyAction = async () => { throw new Error('pending save failed'); };
  await feature.run('redo');
  assert.deepEqual(errors, [['pending save failed', true]]);
  assert.equal(buttons.redo.disabled, false);
  feature.dispose();
});

test('three edits undo and redo byte-for-byte; redo conflict keeps its branch and other canvases are isolated', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'design-redo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = [path.join(root, 'one'), path.join(root, 'two')];
  for (const dir of dirs) await cp(new URL('./editor-fixtures/simple-ui/', import.meta.url), dir, { recursive: true });
  const tx = new EditorTransactions();
  const name = 'Profile.dc.html';
  const read = dir => readFile(path.join(dir, name));
  const originals = await Promise.all(dirs.map(read));
  const versions = [originals[0]];
  async function edit(dir, label) {
    const before = await read(dir);
    const after = Buffer.concat([before, Buffer.from(`\n<!-- ${label} -->`)]);
    await tx.mutate(dir, { label, revisions: { [name]: revisionOf(before) }, changes: { [name]: after } });
    return after;
  }
  for (let i = 1; i <= 3; i++) versions.push(await edit(dirs[0], `edit ${i}`));
  for (let i = 2; i >= 0; i--) { await tx.undo(dirs[0]); assert.deepEqual(await read(dirs[0]), versions[i]); }
  await edit(dirs[1], 'other canvas');
  assert.equal(tx.status(dirs[0]).redoCount, 3);
  const external = Buffer.concat([versions[0], Buffer.from('\n<!-- external -->')]);
  await writeFile(path.join(dirs[0], name), external);
  await assert.rejects(tx.redo(dirs[0]), { status: 409 });
  assert.equal(tx.status(dirs[0]).redoCount, 3);
  assert.deepEqual(await read(dirs[0]), external);
  await writeFile(path.join(dirs[0], name), versions[0]);
  for (let i = 1; i <= 3; i++) { await tx.redo(dirs[0]); assert.deepEqual(await read(dirs[0]), versions[i]); }
  assert.equal(tx.status(dirs[0]).canRedo, false);
});
