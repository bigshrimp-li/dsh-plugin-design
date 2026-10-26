import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EditorTransactions, revisionOf } from '../dist/editor/transactions.js';

async function fixture(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), 'design-transactions-'));
  const dir = path.join(root, 'canvas');
  await cp(new URL('./editor-fixtures/simple-ui/', import.meta.url), dir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const editor = new EditorTransactions(options);
  const read = name => readFile(path.join(dir, name));
  const change = async (name, suffix) => {
    const original = await read(name);
    return editor.mutate(dir, { label: name, revisions: { [name]: revisionOf(original) }, changes: { [name]: Buffer.concat([original, Buffer.from(suffix)]) } });
  };
  return { root, dir, editor, read, change };
}

test('design history follows edits across boards and supports exact undo/redo', async t => {
  const { dir, editor, read, change } = await fixture(t);
  const names = ['Profile.dc.html', 'Layout.dc.html'];
  const before = await Promise.all(names.map(read));
  await change(names[0], '\n<!-- first -->');
  await change(names[1], '\n<!-- second -->');
  assert.equal(editor.status(dir).undoLabel, names[1]);
  assert.deepEqual((await editor.undo(dir)).files, [names[1]]);
  assert.deepEqual(await read(names[1]), before[1]);
  await editor.undo(dir);
  assert.deepEqual(await read(names[0]), before[0]);
  await editor.redo(dir);
  assert.match((await read(names[0])).toString(), /first/);
  assert.equal(editor.status(dir).redoLabel, names[1]);
});

test('no-op and failed revision checks preserve redo; successful edits clear it', async t => {
  const { dir, editor, read, change } = await fixture(t);
  const name = 'Profile.dc.html';
  await change(name, '\n<!-- first -->'); await editor.undo(dir);
  const before = await read(name);
  const noOp = await editor.mutate(dir, { label: 'none', revisions: { [name]: revisionOf(before) }, changes: { [name]: before } });
  assert.equal(noOp.changed, false); assert.equal(noOp.canRedo, true);
  await assert.rejects(editor.mutate(dir, { label: 'stale', revisions: { [name]: 'stale' }, changes: { [name]: before } }), { status: 409 });
  assert.equal(editor.status(dir).canRedo, true);
  await change(name, '\n<!-- different branch -->');
  assert.equal(editor.status(dir).canRedo, false);
});

test('invalid candidates never change source and invalid baseline is rejected', async t => {
  const { dir, editor, read, change } = await fixture(t);
  const name = 'Profile.dc.html'; const before = await read(name);
  await assert.rejects(editor.mutate(dir, { label: 'bad', revisions: { [name]: revisionOf(before) }, changes: { [name]: '<broken>' } }), { status: 422 });
  assert.deepEqual(await read(name), before);
  assert.equal(editor.status(dir).canUndo, false);
  await writeFile(path.join(dir, name), '<broken>');
  await assert.rejects(change('Layout.dc.html', '\n<!-- valid change -->'), { status: 422 });
});

test('external edit during build or undo is retained and history remains available', async t => {
  const { dir, editor, read, change } = await fixture(t);
  const name = 'Profile.dc.html'; const before = await read(name);
  const external = Buffer.concat([before, Buffer.from('\n<!-- external -->')]);
  await assert.rejects(editor.mutate(dir, { label: 'race', revisions: { [name]: revisionOf(before) }, build: async () => {
    await writeFile(path.join(dir, name), external);
    return { [name]: Buffer.concat([before, Buffer.from('\n<!-- own -->')]) };
  } }), { status: 409 });
  assert.deepEqual(await read(name), external);
  await change(name, '\n<!-- next -->'); const after = await read(name);
  await writeFile(path.join(dir, name), external);
  await assert.rejects(editor.undo(dir), { status: 409 });
  assert.equal(editor.status(dir).canUndo, true);
  await writeFile(path.join(dir, name), after);
  await editor.undo(dir); assert.deepEqual(await read(name), external);
});

test('multi-file mutations preserve one operation and truncate bounded history', async t => {
  const { dir, editor, read, change } = await fixture(t, { maxEntries: 2 });
  const names = ['Profile.dc.html', 'Layout.dc.html'];
  const before = Object.fromEntries(await Promise.all(names.map(async name => [name, await read(name)])));
  await editor.mutate(dir, { label: 'pair', revisions: Object.fromEntries(names.map(name => [name, revisionOf(before[name])])), changes: Object.fromEntries(names.map(name => [name, Buffer.concat([before[name], Buffer.from('\n<!-- pair -->')])])) });
  assert.equal(editor.status(dir).undoCount, 1);
  await editor.undo(dir);
  for (const name of names) assert.deepEqual(await read(name), before[name]);
  for (let i = 0; i < 3; i++) await change(names[0], `\n<!-- ${i} -->`);
  assert.equal(editor.status(dir).undoCount, 2);
});

test('symlink paths, missing revisions, and oversized history are rejected', async t => {
  const { root, dir, editor, read } = await fixture(t);
  const name = 'Profile.dc.html'; const before = await read(name);
  await assert.rejects(editor.mutate(dir, { label: 'missing version', revisions: {}, changes: { [name]: before } }), { status: 400 });
  await symlink(root, path.join(dir, 'escape'));
  await assert.rejects(editor.mutate(dir, { label: 'escape', revisions: { 'escape/outside.txt': null }, changes: { 'escape/outside.txt': 'unsafe' } }), { status: 400 });
  await rm(path.join(dir, 'escape'));
  const bounded = new EditorTransactions({ maxBytes: 2 });
  await assert.rejects(bounded.mutate(dir, { label: 'large', revisions: { [name]: revisionOf(before) }, changes: { [name]: Buffer.concat([before, Buffer.from('\n')]) } }), { status: 413 });
  assert.deepEqual(await read(name), before);
});

test('asset creation and board edit undo and redo as one operation', async t => {
  const { dir, editor, read } = await fixture(t);
  const board = 'Profile.dc.html'; const asset = 'assets/0123456789abcdef0123456789abcdef.svg';
  const before = await read(board);
  const payload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
  await editor.mutate(dir, { label: 'paste asset', revisions: { [board]: revisionOf(before), [asset]: null }, changes: { [board]: Buffer.concat([before, Buffer.from('\n<!-- asset pasted -->')]), [asset]: payload } });
  assert.deepEqual(await read(asset), payload);
  await editor.undo(dir);
  assert.deepEqual(await read(board), before);
  await assert.rejects(read(asset), { code: 'ENOENT' });
  await editor.redo(dir);
  assert.deepEqual(await read(asset), payload);
});

test('concurrent mutations serialize and reject stale snapshots', async t => {
  const { dir, editor, read } = await fixture(t);
  const name = 'Profile.dc.html'; const before = await read(name);
  const jobs = ['one', 'two'].map(label => editor.mutate(dir, { label, revisions: { [name]: revisionOf(before) }, changes: { [name]: Buffer.concat([before, Buffer.from(`\n<!-- ${label} -->`)]) } }));
  const results = await Promise.allSettled(jobs);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.status, 409);
  assert.equal(editor.status(dir).undoCount, 1);
});

test('undo and redo retain unchanged link-target and reused-asset dependencies', async t => {
  for (const dependencyKind of ['anchor', 'asset']) {
    await t.test(dependencyKind, async t => {
      const { dir, editor, read } = await fixture(t);
      const board = 'Profile.dc.html';
      const dependency = dependencyKind === 'anchor' ? 'Layout.dc.html' : 'assets/0123456789abcdef0123456789abcdef.svg';
      if (dependencyKind === 'asset') {
        await mkdir(path.join(dir, 'assets'), { recursive: true });
        await writeFile(path.join(dir, dependency), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
      }
      const before = await read(board), dependencyBefore = await read(dependency);
      const after = dependencyKind === 'anchor'
        ? Buffer.from(before.toString().replace('href="Layout.dc.html"', 'href="Layout.dc.html#heading"'))
        : Buffer.from(before.toString().replace('</x-dc>', '<img src="/_blob/0123456789abcdef0123456789abcdef">\n</x-dc>'));
      await editor.mutate(dir, { label: 'paste dependency', revisions: { [board]: revisionOf(before), [dependency]: revisionOf(dependencyBefore) }, changes: { [board]: after } });
      const external = Buffer.from(dependencyBefore.toString().replace(dependencyKind === 'anchor' ? 'id="heading"' : 'width="2"', dependencyKind === 'anchor' ? 'id="other-heading"' : 'width="3"'));
      await writeFile(path.join(dir, dependency), external);
      await assert.rejects(editor.undo(dir), { status: 409 });
      assert.equal(editor.status(dir).undoCount, 1);
      assert.deepEqual(await read(board), after);
      await writeFile(path.join(dir, dependency), dependencyBefore);
      await editor.undo(dir);
      await writeFile(path.join(dir, dependency), external);
      await assert.rejects(editor.redo(dir), { status: 409 });
      assert.equal(editor.status(dir).redoCount, 1);
      assert.deepEqual(await read(board), before);
      assert.deepEqual(await read(dependency), external);
      await writeFile(path.join(dir, dependency), dependencyBefore);
      await editor.redo(dir);
      assert.deepEqual(await read(board), after);
    });
  }
});

test('unchanged dependency snapshots count toward the history memory budget', async t => {
  const { dir, read } = await fixture(t);
  const board = 'Profile.dc.html', dependency = 'Layout.dc.html';
  const before = await read(board), after = Buffer.concat([before, Buffer.from('\n<!-- changed -->')]), other = await read(dependency);
  const editor = new EditorTransactions({ maxBytes: before.length + after.length + other.length - 1 });
  await assert.rejects(editor.mutate(dir, { label: 'bounded dependencies', revisions: { [board]: revisionOf(before), [dependency]: revisionOf(other) }, changes: { [board]: after } }), { status: 413 });
  assert.deepEqual(await read(board), before);
  assert.equal(editor.status(dir).undoCount, 0);
});

test('staged-file cleanup failure after rename or link does not lose installed history', async t => {
  for (const operation of ['rename', 'link']) await t.test(operation, async t => {
    const { dir, editor, read } = await fixture(t);
    const board = 'Profile.dc.html', asset = 'assets/0123456789abcdef0123456789abcdef.svg';
    const before = await read(board);
    const after = Buffer.concat([before, Buffer.from('\n<!-- committed despite cleanup -->')]);
    const payload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
    const revisions = { [board]: revisionOf(before) };
    const changes = { [board]: after };
    if (operation === 'link') { revisions[asset] = null; changes[asset] = payload; }
    const originalRm = fs.rm;
    let injected = false;
    fs.rm = async (file, options) => {
      const name = String(file);
      if (!injected && name.includes('.dsh-write-') && (operation === 'rename' || name.includes(path.sep + 'assets' + path.sep))) {
        injected = true;
        throw Object.assign(new Error('injected temporary-file cleanup failure'), { code: 'EACCES' });
      }
      return originalRm(file, options);
    };
    try {
      const out = await editor.mutate(dir, { label: 'cleanup fault', revisions, changes });
      assert.equal(injected, true);
      assert.equal(out.changed, true);
      assert.equal(out.history.undoCount, 1);
      assert.deepEqual(await read(board), after);
      if (operation === 'link') assert.deepEqual(await read(asset), payload);
    } finally { fs.rm = originalRm; }
    await editor.undo(dir);
    assert.deepEqual(await read(board), before);
    if (operation === 'link') await assert.rejects(read(asset), { code: 'ENOENT' });
  });
});
