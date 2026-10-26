import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('browser entry registers with the host module loader without undeclared globals', () => {
  const entries = [];
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (entry) => entries.push(entry) } },
  }, { filename: 'client.js', timeout: 1000 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, '@local/dsh-plugin-design');
  assert.equal(typeof entries[0].factory, 'function');
});

test('editor coexists with the host sidebar and releases its tab on disposal', () => {
  let plugin;
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => {
      plugin = factory((name) => {
        assert.equal(name, 'react');
        return { createElement: (type, props) => ({ type, props }) };
      });
    } } },
  }, { timeout: 1000 });
  const definitions = new Map();
  const bodies = new Map();
  const effects = [];
  plugin.apply({
    effect: (fn) => effects.push(fn()),
    sidebarRightTabs: {
      register: (definition) => {
        assert.ok(!definitions.has(definition.id));
        definitions.set(definition.id, definition);
        return () => definitions.delete(definition.id);
      },
    },
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'sidebar.right.pane.tab', 'must not claim a host-owned shell slot');
        return fn();
      },
      register: ({ name, key }, body) => {
        assert.equal(name, 'sidebar.right.pane.tab');
        assert.ok(definitions.has(key), 'body must belong to a registered tab type');
        bodies.set(key, body);
        return () => bodies.delete(key);
      },
    },
  });
  assert.equal(definitions.size, 1);
  assert.equal(bodies.size, 1);
  const definition = [...definitions.values()][0];
  assert.equal(definition.kind, 'design-editor');
  assert.equal(definition.guide[0].title(), '设计稿编辑器');
  assert.equal(typeof bodies.get(definition.id), 'function');
  for (const dispose of effects.reverse()) dispose();
  assert.equal(definitions.size, 0);
  assert.equal(bodies.size, 0);
});
