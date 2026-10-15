// Small keyed DOM reconciler: unchanged inputs retain focus, selection and native state.
const svgNames = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath', textpath: 'textPath', foreignobject: 'foreignObject' };
const booleans = new Set('disabled checked selected multiple required readonly autofocus hidden open controls loop muted autoplay'.split(' '));
export function patchChildren(parent, next, old = [], svg = false) {
  const prior = new Map(old.map(v => [v.key, v]));
  let cursor = parent.firstChild;
  for (const v of next) {
    let prev = prior.get(v.key);
    prior.delete(v.key);
    if (prev && prev.tag !== v.tag) { if (cursor === prev.el) cursor = prev.el.nextSibling; dispose(prev); prev = undefined; }
    v.el = prev?.el ?? (v.tag === '#text' ? document.createTextNode('') : svg || v.tag === 'svg'
      ? document.createElementNS('http://www.w3.org/2000/svg', svgNames[v.tag] ?? v.tag) : document.createElement(v.tag));
    if (v.el !== cursor) parent.insertBefore(v.el, cursor);
    cursor = v.el.nextSibling;
    if (v.tag === '#text') {
      if (v.el.nodeValue !== v.text) v.el.nodeValue = v.text;
      continue;
    }
    const previous = prev?.attrs ?? {};
    for (const name of new Set([...Object.keys(previous), ...Object.keys(v.attrs)])) {
      const value = v.attrs[name];
      if (value === previous[name]) continue;
      if (/^on[A-Za-z]/.test(name)) {
        let event = name.slice(2).toLowerCase(), capture = false;
        if (event.endsWith('capture')) { event = event.slice(0, -7); capture = true; }
        if (event === 'doubleclick') event = 'dblclick';
        if (event === 'change' && (v.tag === 'textarea' || v.tag === 'input' && !['checkbox', 'radio', 'file'].includes(v.attrs.type))) event = 'input';
        const key = event + ':' + capture;
        const listeners = v.el.__designListeners ??= new Map();
        if (listeners.has(key)) v.el.removeEventListener(event, listeners.get(key), capture);
        if (typeof value === 'function') { v.el.addEventListener(event, value, capture); listeners.set(key, value); }
        else listeners.delete(key);
      } else if (name === 'ref') {
        if (typeof previous[name] === 'function') previous[name](null);
        else if (previous[name] && typeof previous[name] === 'object') previous[name].current = null;
        if (typeof value === 'function') value(v.el);
        else if (value && typeof value === 'object') value.current = v.el;
      } else if (name === 'style' && value && typeof value === 'object') {
        v.el.removeAttribute('style');
        for (const [prop, val] of Object.entries(value)) {
          const css = prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
          v.el.style.setProperty(css, String(val));
        }
      } else if (booleans.has(name.toLowerCase())) {
        const on = value !== false && value !== null && value !== undefined && value !== 'false';
        v.el.toggleAttribute(name, on);
        if (name.toLowerCase() === 'checked' || name.toLowerCase() === 'selected') v.el[name.toLowerCase()] = on;
      } else if ((name === 'defaultValue' || name === 'defaultChecked') && !prev) {
        v.el[name === 'defaultValue' ? 'value' : 'checked'] = value;
      } else if (name === 'value' && ['input', 'textarea', 'select'].includes(v.tag)) {
        if (v.el.value !== String(value ?? '')) v.el.value = value ?? '';
      } else if (name !== 'key') {
        const attr = name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : svgNames[name] ?? name;
        if (value == null) v.el.removeAttribute(attr);
        else v.el.setAttribute(attr, String(value));
      }
    }
    v.children ??= [];
    patchChildren(v.el, v.children, prev?.children, (svg || v.tag === 'svg') && v.tag !== 'foreignobject');
    // A select's options must exist before setting its controlled value.
    if (v.tag === 'select' && v.attrs.value != null) v.el.value = String(v.attrs.value);
  }
  for (const stale of prior.values()) dispose(stale);
}
export function dispose(v) {
  for (const child of v.children ?? []) dispose(child);
  const ref = v.attrs?.ref;
  if (typeof ref === 'function') ref(null);
  else if (ref && typeof ref === 'object') ref.current = null;
  v.el?.remove();
}
