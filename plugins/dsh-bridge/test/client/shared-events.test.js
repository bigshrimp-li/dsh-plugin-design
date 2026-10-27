import { describe, expect, it, vi } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.services.js");
const { createCoreTransport, createSharedEventSubscriber } = loaded[0].factory();

function events() {
  const sources = [];
  class Events {
    constructor(url) { this.url = url; this.handlers = {}; this.closed = 0; sources.push(this); }
    addEventListener(type, listener) { this.handlers[type] = listener; }
    emit(type, value) { (type === "message" ? this.onmessage : this.handlers[type])?.({ data: JSON.stringify(value) }); }
    close() { this.closed++; }
  }
  return { sources, Events };
}

function tabs() {
  let active = false;
  const queue = [], channels = new Set();
  const drain = () => {
    if (active || !queue.length) return;
    const task = queue.shift(); active = true;
    task.signal.removeEventListener("abort", task.abort);
    Promise.resolve(task.callback()).then(task.resolve, task.reject).finally(() => { active = false; drain(); });
  };
  const locks = { request(name, { signal }, callback) {
    return new Promise((resolve, reject) => {
      const task = { callback, resolve, reject, signal, abort: null };
      task.abort = () => { const at = queue.indexOf(task); if (at >= 0) queue.splice(at, 1); reject(new DOMException("Aborted", "AbortError")); };
      signal.addEventListener("abort", task.abort, { once: true }); queue.push(task); drain();
    });
  } };
  class Channel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const channel of channels) if (channel !== this && channel.name === this.name) channel.onmessage?.({ data }); }
    close() { channels.delete(this); }
  }
  const page = () => {
    const lifecycle = new EventTarget();
    return { lifecycle, subscribe: createSharedEventSubscriber({ locks, Channel, lifecycle }) };
  };
  return { page, queue, channels };
}

describe("shared Core events", () => {
  it("shares the status watcher and raw subscriptions, and releases only the last subscriber", async () => {
    const { Events, sources } = events(), seen = [], live = [];
    const transport = createCoreTransport({ EventSourceImpl: Events, fetchImpl: async () => ({ ok: true, json: async () => ({ connection: "ready" }) }) });
    const stopWatch = transport.watch(() => {}, { intervalMs: 60000 });
    const stopOne = transport.subscribe({ onEvent: event => seen.push(event), onLive: frame => live.push(frame) });
    const stopTwo = createCoreTransport({ EventSourceImpl: Events }).subscribe({ onEvent: () => { throw new Error("broken view"); } });
    expect(sources).toHaveLength(1);
    sources[0].emit("message", { seq: 1 }); sources[0].emit("live", { delta: "actual frame" });
    expect(seen).toEqual([{ seq: 1 }]); expect(live).toEqual([{ delta: "actual frame" }]);
    stopOne(); stopOne(); stopWatch(); expect(sources[0].closed).toBe(0);
    stopTwo(); expect(sources[0].closed).toBe(1);
    const nextStop = transport.subscribe(); expect(sources).toHaveLength(2); nextStop();
  });

  it("uses one connection across eight tabs and transfers ownership when the owner closes", async () => {
    const { Events, sources } = events(), coordinator = tabs(), received = [];
    const pages = Array.from({ length: 8 }, () => coordinator.page());
    const stops = pages.map((page, index) => page.subscribe(Events, "/super-agent/events", { onLive: frame => received.push([index, frame.delta]) }));
    expect(sources).toHaveLength(1);
    sources[0].emit("live", { delta: "all tabs" }); expect(received).toHaveLength(8);
    stops[0](); await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[0].closed).toBe(1);
    received.length = 0; sources[1].emit("live", { delta: "new owner" }); expect(received).toHaveLength(7);
    stops.forEach(stop => stop()); await Promise.resolve();
    expect(sources[1].closed).toBe(1); expect(coordinator.queue).toHaveLength(0); expect(coordinator.channels.size).toBe(0);
  });

  it("releases a hidden page for bfcache and reconnects on pageshow without duplicating listeners", async () => {
    const { Events, sources } = events(), coordinator = tabs(), first = coordinator.page(), second = coordinator.page();
    const seen = [];
    const stopFirst = first.subscribe(Events, "/super-agent/events", { onEvent: event => seen.push(event.seq) });
    const stopSecond = second.subscribe(Events, "/super-agent/events", {});
    first.lifecycle.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    first.lifecycle.dispatchEvent(new Event("pageshow"));
    sources[1].emit("message", { seq: 3 }); expect(seen).toEqual([3]);
    stopSecond(); await vi.waitFor(() => expect(sources).toHaveLength(3));
    sources[2].emit("message", { seq: 4 }); expect(seen).toEqual([3, 4]); stopFirst();
  });
});
