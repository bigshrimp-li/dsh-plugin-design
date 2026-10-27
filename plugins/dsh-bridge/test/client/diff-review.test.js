import { describe, expect, it, vi } from "vitest";

const modules = [];
globalThis.window = { __ModuleLoader__: { load: definition => modules.push(definition) } };
await import("../../src/client/client.space-view.js");
const { createSpaceView, diffLayout, diffSections, codeTokens } = modules[0].factory();

describe("in-page review layout", () => {
  it("reserves chat space, clamps dragging and expands within the same surface", () => {
    expect(diffLayout(1000, 480)).toMatchObject({ width: 480, max: 580, full: false });
    expect(diffLayout(1000, 900).width).toBe(580);
    expect(diffLayout(1000, 100).width).toBe(360);
    expect(diffLayout(1000, 480, true)).toMatchObject({ width: 1000, full: true });
    expect(diffLayout(390, 480)).toMatchObject({ width: 390, full: true });
    expect(diffLayout(1000, NaN).width).toBe(480);
  });
});

describe("diff reading helpers", () => {
  it("groups nearby changes and folds long unchanged ranges without losing lines", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ oldLine: index + 1, newLine: index + 1, text: String(index), kind: index === 4 || index === 6 || index === 24 ? "add" : "same" }));
    const sections = diffSections(rows, 2);
    expect(sections.filter(section => section.type === "hunk").map(section => [section.start, section.end])).toEqual([[2, 9], [22, 27]]);
    expect(sections.flatMap(section => rows.slice(section.start, section.end))).toEqual(rows);
    expect(diffSections([])).toEqual([]);
  });

  it("preserves source text and uses safe tokens instead of HTML", () => {
    const source = 'const message = "<script>alert(1)</script>"; // note';
    const tokens = codeTokens(source, "src/example.ts");
    expect(tokens.map(token => token.text).join("")).toBe(source);
    expect(tokens).toContainEqual({ kind: "keyword", text: "const" });
    expect(tokens.at(-1)).toEqual({ kind: "comment", text: "// note" });
    expect(codeTokens(source, "example.txt")).toEqual([{ kind: "plain", text: source }]);
    expect(codeTokens("x".repeat(25000), "example.ts").map(token => token.text).join("")).toHaveLength(25000);
  });
});

function element(type, props, ...children) { return { type, props: { ...props, children } }; }
function nodes(value, result = []) {
  if (Array.isArray(value)) value.forEach(item => nodes(item, result));
  else if (value && typeof value === "object") { result.push(value); nodes(value.props?.children, result); nodes(value.props?.footer, result); nodes(value.props?.anchor, result); }
  return result;
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" ? text(value.props?.children) + text(value.props?.footer) : "";
}
function fixture() {
  const states = [], effects = [];
  let cursor = 0;
  const React = {
    Fragment: "fragment", createElement: element,
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return states[index] ||= { current: initial }; },
    useEffect(effect, deps) { const index = cursor++; if (!states[index] || deps.some((dep, at) => dep !== states[index].deps[at])) { states[index]?.cleanup?.(); states[index] = { deps }; effects.push(() => { states[index].cleanup = effect(); }); } },
  };
  const files = ["src/retry.ts", "src/queue.ts"].map(path => ({ path, status: "available", additions: 1, deletions: 1, before: { content: "old", hash: "hidden-before" }, after: { content: "new" }, current: { hash: "hidden-current" }, rows: [
    { oldLine: 1, newLine: null, kind: "remove", text: "const n = 1;" },
    { oldLine: null, newLine: 1, kind: "add", text: "const n = 2;" },
  ] }));
  const controller = {
    loadRunDiff: vi.fn(async () => ({ files, artifacts: { run: { status: "succeeded" } }, branch: { revision: 2 } })),
    listDiffRuns: vi.fn(async () => [{ runId: "run-private", round: 2, fileCount: 2 }, { runId: "run-next", round: 4, fileCount: 1 }]),
    openDiff: vi.fn(), selectDiffFile: vi.fn(), closeDiff: vi.fn(), reportError: vi.fn(),
    rollbackRun: vi.fn(async () => ({ restoredCount: 2, conflictCount: 0, alreadyRestoredCount: 0, items: [] })),
  };
  const s = { diffSelection: { runId: "run-private", filePath: null }, selected: { threadId: "thread", conversationId: "conversation" }, threads: [],
    runDetails: [{ runId: "first", conversationId: "conversation" }, { runId: "run-private", conversationId: "conversation", status: "completed" }] };
  const primitives = { Menu: "menu", Modal: "modal", Tooltip: "tooltip" };
  const { DiffPanel } = createSpaceView({ kernel: { React, h: element }, controller, primitives, services: {}, ctx: {} });
  const props = { s, layout: diffLayout(1000, 480), expanded: false, onResize: vi.fn(), onExpand: vi.fn() };
  const render = () => { cursor = 0; const tree = DiffPanel(props); while (effects.length) effects.shift()(); return tree; };
  return { render, controller, props };
}

describe("review panel interactions", () => {
  it("switches real rounds/files, wraps code and expands without a new window", async () => {
    const view = fixture(); view.render(); await Promise.resolve();
    let tree = view.render(), all = nodes(tree);
    expect(text(tree)).toContain("第 2 轮变更");
    expect(text(tree)).not.toContain("统一视图");
    all.find(node => node.props?.["aria-label"] === "变更轮次").props.onChange({ target: { value: "run-next" } });
    await Promise.resolve();
    expect(view.controller.openDiff).toHaveBeenCalledWith("run-next");
    all.find(node => node.props?.["aria-label"] === "下一个文件").props.onClick();
    expect(view.controller.selectDiffFile).toHaveBeenCalledWith("src/queue.ts");
    const wrap = all.find(node => node.props?.["aria-label"] === "自动换行");
    expect(wrap.props["aria-pressed"]).toBe(true); wrap.props.onClick();
    tree = view.render();
    expect(nodes(tree).find(node => node.props?.["aria-label"] === "自动换行").props["aria-pressed"]).toBe(false);
    nodes(tree).find(node => node.props?.["aria-label"] === "展开审阅").props.onClick();
    expect(view.props.onExpand).toHaveBeenCalled();
    expect(view.controller.rollbackRun).not.toHaveBeenCalled();
  });

  it("supports keyboard resizing and keeps destructive confirmation readable", async () => {
    const view = fixture(); view.render(); await Promise.resolve();
    let all = nodes(view.render());
    const divider = all.find(node => node.props?.role === "separator");
    divider.props.onKeyDown({ key: "ArrowLeft", preventDefault() {} });
    expect(view.props.onResize).toHaveBeenCalledWith(504);
    const menu = all.find(node => node.type === "menu");
    expect(menu.props.items[0].label).toBe("撤销本轮全部改动");
    menu.props.onSelect("rollback");
    let tree = view.render(); all = nodes(tree);
    const dialog = all.find(node => node.type === "modal");
    expect(dialog.props.open).toBe(true);
    expect(text(dialog)).toContain("2 个文件");
    expect(text(dialog)).not.toMatch(/run-private|hidden-before|hidden-current|快照.*修订/);
    expect(all.find(node => node.type === "button" && text(node) === "确认撤销").props.disabled).toBe(true);
    all.find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
    tree = view.render();
    nodes(tree).find(node => node.type === "button" && text(node) === "确认撤销").props.onClick();
    await Promise.resolve();
    expect(view.controller.rollbackRun).toHaveBeenCalledWith("run-private");
  });

  it("keeps a readable diff when the round index fails and shows honest binary counts", async () => {
    const view = fixture();
    view.controller.listDiffRuns.mockRejectedValue(new Error("temporarily unavailable"));
    view.controller.loadRunDiff.mockResolvedValue({ files: [{ path: "asset.bin", binary: true, status: "binary", rows: [], additions: null, deletions: null }], artifacts: { run: { status: "succeeded" } } });
    view.render(); await Promise.resolve(); await Promise.resolve();
    const tree = view.render();
    expect(text(tree)).toContain("其他轮次读取失败");
    expect(text(tree)).toContain("二进制文件");
    expect(text(tree)).toContain("+?−?");
    expect(nodes(tree).some(node => node.props?.role === "table")).toBe(false);
    expect(view.controller.closeDiff).not.toHaveBeenCalled();
  });

  it("handles pointer capture, cancellation and Escape without submitting file operations", async () => {
    const view = fixture(); view.render(); await Promise.resolve();
    const tree = view.render(), divider = nodes(tree).find(node => node.props?.role === "separator");
    const target = { focus: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
    divider.props.onPointerDown({ pointerId: 1, button: 0, clientX: 500, currentTarget: target, preventDefault() {} });
    divider.props.onPointerMove({ pointerId: 1, clientX: 380 });
    expect(view.props.onResize).toHaveBeenCalledWith(580);
    divider.props.onPointerCancel({ pointerId: 1, currentTarget: target });
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    divider.props.onPointerMove({ pointerId: 1, clientX: 380 });
    expect(view.props.onResize).toHaveBeenCalledTimes(1);
    tree.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    expect(view.controller.closeDiff).toHaveBeenCalledTimes(1);
    view.props.expanded = true;
    view.render().props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    expect(view.props.onExpand).toHaveBeenCalled();
    expect(view.controller.rollbackRun).not.toHaveBeenCalled();
  });
});
