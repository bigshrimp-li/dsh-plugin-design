import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listElements, setInlineStyle, setText } from '../dist/editor/source.js';

test('HTML comments do not shift source IDs', () => {
  const src = '<x-dc><div><!-- <button>not a node</button> --><p>Text</p></div></x-dc>';
  assert.deepEqual(listElements(src).map(e => [e.tid, e.tag]), [[0, 'div'], [1, 'p']]);
  assert.match(setText(src, 1, 'Changed'), /<p>Changed<\/p>/);
});
test('style values containing quotes round trip without introducing attributes', () => {
  for (const source of ['<x-dc><p style="color: red">Text</p></x-dc>', "<x-dc><p style='color: red'>Text</p></x-dc>", '<x-dc><p>Text</p></x-dc>']) {
    const style = `font-family: "Arial", 'sans-serif'; --label: 'a&b'`;
    const result = setInlineStyle(source, 0, style);
    assert.equal(listElements(result)[0].style, style);
    assert.equal(listElements(result)[0].attrs.length, 1);
  }
});
test('removing a spaced style attribute preserves adjacent attributes', () => {
  assert.equal(setInlineStyle('<x-dc><p id="a" style = "color: red" title="b">Text</p></x-dc>', 0, ''), '<x-dc><p id="a" title="b">Text</p></x-dc>');
});
test('style/script bodies cannot be edited as literal text', () => {
  assert.throws(() => setText('<x-dc><style>p{color:red}</style></x-dc>', 0, 'changed'));
});
