/**
 * Browser regression without Playwright.
 *
 * The project depends on nothing but Node and a local Chrome. This script
 * drives that Chrome over the DevTools Protocol: it opens a live session URL,
 * waits for the trace tree to render, expands a Run and a Turn, switches to the
 * waterfall, captures screenshots and fails on any page error.
 *
 * Usage:
 *   node tests/browser-cdp.mjs --url "http://127.0.0.1:3789/?provider=codex&session=<id>" \
 *     --out /path/to/screenshots
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const url = option("url", "http://127.0.0.1:3789/");
const outDir = option("out", path.join(tmpdir(), "asv-cdp"));
const chromePath = option("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const timeoutMs = Number(option("timeout", "90000"));

const profile = await mkdtemp(path.join(tmpdir(), "asv-cdp-profile-"));
await mkdir(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-extensions",
  "--window-size=1680,1050",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsPort() {
  const file = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(file, "utf8")).split("\n");
      if (port) return Number(port);
    } catch {
      await sleep(120);
    }
  }
  throw new Error("Chrome did not expose a DevTools port");
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener) { this.listeners.push(listener); }
}

async function main() {
  const port = await devtoolsPort();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("No page target");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(socket);
  const errors = [];
  cdp.on((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      console.error("BROWSER UNCAUGHT:", JSON.stringify(message.params.exceptionDetails));
      errors.push(message.params.exceptionDetails?.text || "exception");
    }
    if (message.method === "Runtime.consoleAPICalled") {
      console.log("BROWSER LOG:", message.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      if (message.params.type === "error") {
        errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      console.error("BROWSER LOG ERROR:", message.params.entry.text);
      errors.push(message.params.entry.text);
    }
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1050, deviceScaleFactor: 2, mobile: false });

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  const waitFor = async (expression, label, timeout = timeoutMs) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  console.log("STEP 1: navigating to", url);
  await cdp.send("Page.navigate", { url });
  console.log("STEP 2: waiting for page load");
  await waitFor("document.readyState === 'complete'", "page load");
  console.log("STEP 3: page loaded, waiting for graph nodes");
  await waitFor("Boolean(document.querySelectorAll('.graph-node-shell').length > 10)", "graph nodes ready", 120000);
  console.log("STEP 4: graph nodes ready");
  await sleep(1000);

  // 1. Verify Execution Graph View (default view)
  const graphSnapshot = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.graph-node-shell')];
    const lanes = [...document.querySelectorAll('.lane')];
    const spawnEdges = [...document.querySelectorAll('.graph-edge.edge-spawn')];
    const returnEdges = [...document.querySelectorAll('.graph-edge.edge-return')];
    return {
      title: document.title,
      nodes: nodes.length,
      lanes: lanes.length,
      spawnEdges: spawnEdges.length,
      returnEdges: returnEdges.length,
      visible: !document.querySelector('#graph-viewport').hidden,
    };
  })()`);
  console.log("GRAPH", JSON.stringify(graphSnapshot, null, 2));
  if (graphSnapshot.nodes < 5) throw new Error("Graph nodes failed to render");

  // Test Magpie smart summary button on first lane
  const summaryTest = await evaluate(`(async () => {
    const btn = document.querySelector('.btn-agent-summary');
    if (!btn) return { ok: false, reason: "no summary button" };
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    const box = document.querySelector('.agent-summary-result .summary-box');
    return { ok: Boolean(box), text: box?.innerText || "" };
  })()`);
  console.log("MAGPIE SUMMARY TEST:", JSON.stringify(summaryTest, null, 2));

  await capture(cdp, path.join(outDir, "graph-view.png"));

  // 2. Switch to Run Performance View
  await evaluate("document.querySelector('#view-switch [data-view=\"run\"]')?.click()");
  await sleep(800);

  const runSnapshot = await evaluate(`(() => {
    const kpiCards = [...document.querySelectorAll('.perf-kpi-card')];
    const kpiValues = kpiCards.map(c => c.querySelector('.perf-kpi-val')?.innerText || '');
    return {
      visible: !document.querySelector('#run-view').hidden,
      kpiCount: kpiCards.length,
      kpiValues,
      waterfallRows: document.querySelectorAll('#run-waterfall .wf-row').length,
    };
  })()`);
  console.log("RUN PERFORMANCE VIEW", JSON.stringify(runSnapshot, null, 2));
  if (runSnapshot.kpiCount < 4) throw new Error("KPI cards failed to render");

  await capture(cdp, path.join(outDir, "run-waterfall.png"));

  // 3. Context Tab in detail panel
  const contextTab = await evaluate(`(async () => {
    document.querySelector('.detail-tab[data-tab="context"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      cards: document.querySelectorAll('.context-card').length,
      blocks: document.querySelectorAll('.context-block').length,
      text: document.querySelector('#detail-content')?.innerText.slice(0, 160) || '',
    };
  })()`);
  console.log("CONTEXT", JSON.stringify(contextTab, null, 2));
  await capture(cdp, path.join(outDir, "context.png"));

  // Execution graph view keeps working next to the tree.
  const graphView = await evaluate(`(async () => {
    document.querySelector('#view-switch [data-view="graph"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const svg = document.querySelector('#graph-svg');
    return {
      nodes: document.querySelectorAll('.graph-node-shell').length,
      edges: document.querySelectorAll('.graph-edge').length,
      viewBox: svg?.getAttribute('viewBox') || '',
      visible: !document.querySelector('#graph-viewport').hidden,
    };
  })()`);
  console.log("GRAPH", JSON.stringify(graphView, null, 2));
  if (!graphView.visible || graphView.nodes < 2) throw new Error("execution graph view did not render");
  if (/NaN/.test(graphView.viewBox)) throw new Error(`graph viewBox is invalid: ${graphView.viewBox}`);
  await capture(cdp, path.join(outDir, "graph-view.png"));
  await evaluate("document.querySelector('#view-switch [data-view=\"tree\"]')?.click()");

  if (args.includes("--stress")) {
    const stress = await evaluate(`(async () => {
      const view = document.querySelector('#view-switch [data-view="tree"]');
      view?.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const firstRun = document.querySelector('#trace-tree [data-run-id]');
      const started = performance.now();
      firstRun?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const turnRows = document.querySelectorAll('#trace-tree [data-turn-id]').length;
      const more = document.querySelector('#trace-tree [data-more-turns]');
      more?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterMore = document.querySelectorAll('#trace-tree [data-turn-id]').length;
      const chevron = document.querySelector('#trace-tree [data-turn-id] [data-toggle]') || document.querySelector('#trace-tree [data-turn-id]');
      chevron?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const itemRows = document.querySelectorAll('#trace-tree [data-item-id]').length;
      document.querySelector('#view-switch [data-view="run"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        elapsedMs: Math.round(performance.now() - started),
        turnRows, afterMore, itemRows,
        waterfallRows: document.querySelectorAll('#run-waterfall .wf-row').length,
        note: document.querySelector('.run-view-note')?.innerText || '',
      };
    })()`);
    console.log("STRESS", JSON.stringify(stress, null, 2));
    if (stress.waterfallRows < 2) throw new Error("waterfall did not render the large run");
    await capture(cdp, path.join(outDir, "run-large.png"));
  }

  if (errors.length) throw new Error(`Page errors:\n${errors.join("\n")}`);
  console.log("PASS: trace tree, run detail, waterfall and context rendered without page errors");
}

async function capture(cdp, file) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(file, Buffer.from(data, "base64"));
  console.log("SCREENSHOT", file);
}

try {
  await main();
} catch (error) {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
}
