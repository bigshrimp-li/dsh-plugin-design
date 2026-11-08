// Run the packaged Desktop main, Host and renderer without showing a test window on the user's desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

async function until(read, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timed out waiting for ${description}`);
}

async function connectInspector(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  const pending = new Map(), events = new Map();
  let id = 0;
  ws.onclose = () => {
    const error = Error("Desktop inspector closed");
    for (const request of [...pending.values(), ...events.values()]) request.reject(error);
    pending.clear(); events.clear();
  };
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message));
      else request.resolve(message.result);
    } else if (events.has(message.method)) {
      events.get(message.method).resolve(message.params);
      events.delete(message.method);
    }
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    next(method) { return new Promise((resolve, reject) => events.set(method, { resolve, reject })); },
    close() { ws.close(); },
  };
}

export async function withHiddenDesktop({ executable, chromiumHome, env, cwd }, inspect) {
  await rm(join(chromiumHome, "DevToolsActivePort"), { force: true });
  const child = spawn(executable, ["--inspect-brk=127.0.0.1:0", "--remote-debugging-port=0",
    `--user-data-dir=${chromiumHome}`, "--no-first-run", "--disable-background-networking",
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost"], {
    cwd, env: { ...env, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost", NODE_USE_ENV_PROXY: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", inspector, browser;
  const collect = chunk => { output = (output + String(chunk)).slice(-32768); };
  child.stderr.on("data", collect); child.stdout.on("data", collect);
  const exited = once(child, "exit");
  try {
    const inspectorURL = await until(() => output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[\w-]+)/)?.[1], "Desktop inspector", 30000);
    inspector = await connectInspector(inspectorURL);
    await inspector.send("Runtime.enable"); await inspector.send("Debugger.enable");
    const pause = inspector.next("Debugger.paused");
    await inspector.send("Runtime.runIfWaitingForDebugger");
    const { callFrames } = await Promise.race([pause, delay(10000, null, { ref: false }).then(() => {
      throw Error("Packaged Desktop did not pause before its entry point");
    })]);
    // Gate the process before the packaged application's first statement. Only OS presentation
    // and default-protocol registration are suppressed. Plugin validation and rendering run intact.
    const { result, exceptionDetails } = await inspector.send("Debugger.evaluateOnCallFrame", {
      callFrameId: callFrames[0].callFrameId, returnByValue: true,
      expression: `(() => {
        const { app, BrowserWindow } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
        if (app.getPath("userData") !== ${JSON.stringify(chromiumHome)}) throw Error("Desktop Chromium profile isn't isolated");
        app.setActivationPolicy("prohibited");
        app.setAsDefaultProtocolClient = () => false;
        app.focus = BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = BrowserWindow.prototype.focus = () => {};
        app.on("browser-window-created", (_event, window) => {
          // Record native transitions even if they occur between the renderer assertions.
          for (const name of ["show", "focus"]) window.on(name, () => {
            globalThis.__releaseUnexpectedPresentation = name;
            window.hide();
          });
        });
        return app.getPath("userData");
      })()`,
    });
    assert.equal(exceptionDetails, undefined, result?.description); assert.equal(result.value, chromiumHome);
    await inspector.send("Debugger.disable");
    const port = await until(async () => {
      try { return Number((await readFile(join(chromiumHome, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
      catch { return null; }
    }, "Chromium debugging port");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(p => {
      const url = p.url();
      return url.startsWith("dsh://") || url.startsWith("dsh-app://") || url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:");
    }), "packaged workspace renderer");
    const observation = await inspect(page);
    const { result: presentation, exceptionDetails: presentationError } = await inspector.send("Runtime.evaluate", {
      expression: `(() => {
        const { BrowserWindow } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
        return { transition: globalThis.__releaseUnexpectedPresentation || null, focused: !!BrowserWindow.getFocusedWindow(),
          visible: BrowserWindow.getAllWindows().some(win => win.isVisible()) };
      })()`, returnByValue: true,
    });
    assert.equal(presentationError, undefined);
    assert.deepEqual(presentation.value, { transition: null, focused: false, visible: false },
      "The test Desktop gained native focus or displayed a window");
    return observation;
  } catch (error) {
    const safe = output.replace(/(token=)[^\s"']+/gi, "$1[redacted]").slice(-3000);
    throw Error(`${error.message}\n${safe}`, { cause: error });
  } finally {
    if (inspector) {
      const quitting = inspector.send("Runtime.evaluate", { expression: "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit()" });
      await Promise.race([quitting.catch(() => {}), delay(800)]);
      inspector.close();
    }
    await browser?.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      const finished = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
      if (!finished) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await exited;
      }
    }
  }
}
