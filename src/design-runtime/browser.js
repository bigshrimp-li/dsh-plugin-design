import { parseMarkup, boardDefinition } from './markup.ts';
import { bind, defaults } from './bindings.js';
import { patchChildren, dispose } from './dom.js';

const VERSION = 'dsh-dom-1';
const definitions = new Map();
const decode = value => { const el = document.createElement('textarea'); el.innerHTML = value; return el.value; };
const errors = [];
function report(error) {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  console.error('[Design runtime]', message);
  window.dispatchEvent(new CustomEvent('design-runtime-error', { detail: message }));
}
class DCLogic {
  constructor(props = {}) { this.props = props; this.state = {}; }
  setState(update, callback) {
    const delta = typeof update === 'function' ? update(this.state, this.props) : update;
    this.state = { ...this.state, ...delta };
    if (callback) (this._callbacks ??= []).push(callback);
    this._schedule?.();
  }
  forceUpdate(callback) { if (callback) (this._callbacks ??= []).push(callback); this._schedule?.(); }
  renderVals() { return {}; }
}
function definition(template, logic, props, url) {
  const parsed = parseMarkup(template);
  if (parsed.problems.length) throw new Error(`${url}: ${parsed.problems.join('; ')}`);
  // Logic is user-authored classic JavaScript, with the same trust as the design file.
  const Component = new Function('DCLogic', `"use strict";\n${logic}\nreturn Component;`)(DCLogic);
  if (!(Component.prototype instanceof DCLogic)) throw new Error('Component must extend DCLogic');
  return { ...parsed, Component, props, url };
}
function importUrl(name, base) {
  if (!name || /[?#\\]/.test(name)) throw new Error(`Invalid component name: ${name}`);
  const url = new URL(name.endsWith('.dc.html') ? name : name + '.dc.html', base);
  if (url.origin !== new URL(base).origin) throw new Error('Component imports must remain local');
  return url.href;
}
async function load(url, chain = []) {
  if (chain.includes(url)) throw new Error(`Circular component import: ${[...chain, url].join(' -> ')}`);
  if (chain.length > 32) throw new Error('Component imports exceed 32 levels');
  if (definitions.has(url)) return definitions.get(url);
  const relative = new URL(url).pathname;
  const embedded = window.__designSources?.[url];
  let source = embedded;
  if (source === undefined) {
    if (location.protocol === 'file:') throw new Error(`Missing embedded component: ${relative}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Component unavailable (${response.status}): ${url}`);
    source = await response.text();
  }
  const data = boardDefinition(source);
  const def = definition(data.template, data.logic, data.props, url);
  await preload(def, [...chain, url]);
  definitions.set(url, def);
  return def;
}
async function preload(def, chain) {
  async function visit(nodes) {
    for (const n of nodes) {
      if (n.tag === 'dc-import') {
        if (/{{/.test(n.attrs.name ?? '')) throw new Error('Component names must be static');
        await load(importUrl(decode(n.attrs.name ?? ''), def.url), chain);
      }
      if (n.tag === 'x-import') throw new Error('x-import is not supported by the local DOM runtime; use dc-import or a local custom element');
      await visit(n.children);
    }
  }
  await visit(def.nodes);
}
function start(def) {
  const root = document.createElement('div'); root.id = 'dc-root'; document.body.append(root);
  const headHost = document.createElement('template'); document.head.append(headHost);
  const instances = new Map(); let previous = [], headPrevious = [], headNext = [], queued = false, stopped = false;
  let active = new Set();
  const schedule = () => { if (!queued && !stopped) { queued = true; queueMicrotask(render); } };
  const eventValue = fn => typeof fn !== 'function' ? fn : event => {
    try { const result = fn(event); if (result?.catch) result.catch(report); } catch (error) { report(error); }
  };
  function component(current, props, key, isRoot = false) {
    let record = instances.get(key);
    if (!record) {
      const input = { ...defaults(current.props), ...props };
      const instance = new current.Component(input); instance.props = input; instance._schedule = schedule;
      record = { instance, mounted: false, previousProps: input, previousState: { ...instance.state } };
      instances.set(key, record);
    } else { record.instance.props = { ...defaults(current.props), ...props }; }
    active.add(key);
    const values = record.instance.renderVals() ?? {};
    const children = expand(current.nodes, values, current, key);
    const preview = current.props.$preview ?? {};
    const style = isRoot ? `position:relative;${Number.isFinite(preview.width) ? `width:${preview.width}px;` : ''}${Number.isFinite(preview.height) ? `min-height:${preview.height}px;` : ''}` : 'display:contents';
    return { key, tag: 'div', attrs: { class: 'sc-host', 'data-design-host': key, style }, children };
  }
  function expand(nodes, scope, current, base) {
    const output = [];
    nodes.forEach((n, position) => {
      const key = base + '/' + (n.tid < 0 ? 't' + position : n.tid);
      if (n.tag === '#text') { output.push({ key, tag: '#text', text: String(bind(decode(n.text ?? ''), scope) ?? '') }); return; }
      const attrs = Object.fromEntries(Object.entries(n.attrs).map(([k, v]) => [k, k === 'key' && n.tag === 'sc-for' ? v : bind(decode(v), scope)]));
      if (n.tag === 'sc-if') {
        if (attrs.value ?? attrs['hint-placeholder-val']) output.push(...expand(n.children, scope, current, key));
      } else if (n.tag === 'sc-for') {
        const list = attrs.list ?? [];
        if (!Array.isArray(list)) throw new Error('sc-for list must be an array');
        const keys = new Set();
        list.forEach((item, index) => {
          const childScope = { ...scope, [attrs.as || 'item']: item, $index: index };
          const itemKey = n.attrs.key ? bind(n.attrs.key, childScope) : item?.id ?? index;
          const identity = String(itemKey);
          if (keys.has(identity)) throw new Error(`Duplicate list key: ${identity}`);
          keys.add(identity);
          output.push(...expand(n.children, childScope, current, key + ':' + encodeURIComponent(identity)));
        });
      } else if (n.tag === 'dc-import') {
        const url = importUrl(String(attrs.name), current.url);
        const child = definitions.get(url);
        if (!child) throw new Error(`Component not loaded: ${url}`);
        const props = Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'name' && !k.startsWith('hint-')).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
        output.push(component(child, props, key));
      } else if (n.tag === 'helmet') {
        headNext.push(...expand(n.children, scope, current, key).filter(v => ['style', 'link', 'meta', 'title'].includes(v.tag)));
      } else {
        const safe = Object.fromEntries(Object.entries(attrs).filter(([k]) => !k.startsWith('data-dc-tpl') && !k.startsWith('data-design-')));
        for (const name of Object.keys(safe)) if (/^on[A-Za-z]/.test(name)) safe[name] = eventValue(safe[name]);
        safe['data-dc-tpl'] = String(n.tid);
        safe['data-design-node'] = String(n.tid);
        const children = ['style', 'script'].includes(n.tag) ? n.children.map((t, i) => ({ key: key + '/raw' + i, tag: '#text', text: String(bind(t.text ?? '', scope) ?? '') })) : expand(n.children, scope, current, key);
        output.push({ key, tag: n.tag, attrs: safe, children });
      }
    });
    return output;
  }
  function render() {
    queued = false; if (stopped) return;
    active = new Set(); headNext = [];
    try {
      const next = [component(def, api.props, 'root', true)];
      patchChildren(root, next, previous); previous = next;
      // A detached fragment owns only our head nodes; move them into the head after patching.
      for (const v of headPrevious) headHost.content.append(v.el);
      patchChildren(headHost.content, headNext, headPrevious); headPrevious = headNext;
      for (const v of headNext) document.head.append(v.el);
      for (const [key, record] of instances) {
        const instance = record.instance;
        if (!active.has(key)) { instance.componentWillUnmount?.(); instance._schedule = null; instances.delete(key); continue; }
        const previousProps = record.previousProps, previousState = record.previousState;
        record.previousProps = instance.props; record.previousState = { ...instance.state };
        if (!record.mounted) { record.mounted = true; instance.componentDidMount?.(); }
        else instance.componentDidUpdate?.(previousProps, previousState);
        for (const callback of instance._callbacks?.splice(0) ?? []) callback.call(instance);
      }
    } catch (error) { report(error); }
  }
  const api = { version: VERSION, errors, props: {}, setProps(props) { this.props = { ...this.props, ...props }; schedule(); },
    dispose() { stopped = true; for (const { instance } of instances.values()) { instance.componentWillUnmount?.(); instance._schedule = null; } instances.clear(); previous.forEach(dispose); headPrevious.forEach(dispose); root.remove(); headHost.remove(); } };
  window.__designRuntime = api; render();
  window.addEventListener('pagehide', () => api.dispose(), { once: true });
  window.parent.postMessage({ type: '__dc_booted', runtime: VERSION }, '*');
}
async function boot() {
  try {
    const template = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    if (!template || !script) throw new Error('Missing design template or logic');
    template.hidden = true;
    const preserved = document.querySelector('script[data-design-template]');
    const def = definition(preserved ? JSON.parse(preserved.textContent) : template.innerHTML,
      script.textContent, JSON.parse(script.getAttribute('data-props') ?? '{}'), location.href);
    template.remove();
    await preload(def, [location.href]);
    definitions.set(location.href, def); start(def);
  } catch (error) {
    report(error);
    const failure = document.createElement('pre'); failure.dataset.designError = 'true'; failure.textContent = errors.join('\n'); document.body.append(failure);
    window.__designRuntime = { version: VERSION, errors };
  }
}
// Hide raw templates before DOMContentLoaded to avoid a flash of bindings.
const hiding = document.createElement('style'); hiding.textContent = 'x-dc{display:none!important}'; document.head.append(hiding);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
