import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSourceRef, validateSourceRef } from '../dist/editor/source.js';

const context = { canvas: 'design', board: 'Home.dc.html' };
const source = '<x-dc><div><p>Text</p></div></x-dc>';

test('source references cannot cross files or source revisions', () => {
  const ref = createSourceRef(source, context, 1);
  assert.equal(validateSourceRef(source, ref, context).tag, 'p');
  assert.throws(() => validateSourceRef(source, ref, { ...context, board: 'Other.dc.html' }), /来源/);
  assert.throws(() => validateSourceRef(source.replace('Text', 'New'), ref, context), /过期/);
  assert.throws(() => validateSourceRef(source, { ...ref, tid: -1 }, context), /编号/);
  assert.throws(() => validateSourceRef(source, null, context), /来源/);
});

test('source validation rejects direct import and slotted descendants', () => {
  const imported = '<x-dc><dc-import name="Card"><p>slot</p></dc-import></x-dc>';
  for (const tid of [0, 1]) {
    assert.throws(() => validateSourceRef(imported, createSourceRef(imported, context, tid), context), /组件/);
  }
});

// A tiny runtime DOM fixture exercises the actual bridge against the host
// boundaries produced by the vendored runtime, without starting a browser.
function bridgeFixture() {
  const all = [];
  function node(tag, tid, parent, classes = '') {
    const el = { tagName: tag.toUpperCase(), parentElement: parent, children: [], isConnected: true,
      textContent: 'Text', style: {},
      getAttribute(name) { return name === 'data-dc-tpl' ? (tid === null ? null : String(tid)) : name === 'class' ? classes : ''; },
      hasAttribute(name) { return name === 'data-dc-tpl' && tid !== null; },
      matches() { return /(?:^| )(?:sc-host|sc-host-x)(?: |$)/.test(classes); },
      contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 50, height: 20 }; },
    };
    if (parent) parent.children.push(el);
    all.push(el);
    return el;
  }
  const metadata = node('style', 4, node('head', null, null));
  const host = node('div', null, null, 'sc-host');
  const parent = node('div', 0, host);
  const first = node('p', 2, parent), second = node('p', 2, parent);
  const importHost = node('div', 3, parent, 'sc-host');
  const imported = node('p', 2, importHost);
  const mismatch = node('button', 2, parent);
  const document = {
    documentElement: {},
    querySelector(selector) { return selector === '#dc-root > .sc-host' ? host : null; },
    querySelectorAll(selector) {
      const tid = /data-dc-tpl="(\d+)"/.exec(selector)?.[1];
      return all.filter(el => el.hasAttribute('data-dc-tpl') && (tid === undefined || el.getAttribute('data-dc-tpl') === tid));
    },
  };
  const window = { scrollX: 0, scrollY: 0 }; window.parent = window;
  vm.runInNewContext(readFileSync(new URL('../src/editor/assets/bridge.js', import.meta.url), 'utf8'), {
    window, document, AbortController, setInterval() {}, getComputedStyle() { return { fontFamily: 'sans-serif' }; },
  });
  const bridge = window.__designEditor;
  bridge.registerSources({
    0: { tag: 'div', parentTid: null, style: '' },
    1: { tag: 'sc-for', parentTid: 0, style: '' },
    2: { tag: 'p', parentTid: 1, style: '', editableText: true },
    3: { tag: 'dc-import', parentTid: 0, style: '' },
  }, { ...context, revision: 'r1' });
  return { bridge, first, second, imported, mismatch, metadata };
}

test('repeated template instances retain separate instance identity and revision', () => {
  const { bridge, first, second } = bridgeFixture();
  const a = bridge.describe(2, first), b = bridge.describe(2, second);
  assert.equal(a.writable, true);
  assert.equal(b.writable, true);
  assert.deepEqual(JSON.parse(JSON.stringify(a.sourceRef)), { ...context, revision: 'r1', tid: 2 });
  assert.equal(a.instance.index, 0);
  assert.equal(b.instance.index, 1);
  assert.equal(b.instances, 2);
  bridge.updateSourceContext({ revision: 'r2' });
  assert.equal(bridge.describe(2, first).sourceRef.revision, 'r2');
});

test('imported tid collisions and runtime/source tag mismatches are read only', () => {
  const { bridge, imported, mismatch } = bridgeFixture();
  for (const target of [imported, mismatch]) {
    const description = bridge.describe(2, target);
    assert.equal(description.writable, false);
    assert.equal(description.sourceRef, null);
    assert.equal(description.editableText, false);
    assert.ok(description.readonlyReason);
  }
});


test('helmet metadata relocated into head has no board instance and remains read only', () => {
  const { bridge, metadata } = bridgeFixture();
  const info = bridge.describe(4, metadata);
  assert.equal(info.writable, false);
  assert.equal(info.sourceRef, null);
  assert.equal(info.instance.index, -1);
  assert.equal(info.instance.count, 0);
});
