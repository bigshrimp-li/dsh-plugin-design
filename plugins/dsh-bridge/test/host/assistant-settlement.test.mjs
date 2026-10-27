/**
 * A written session must be a session the harness can *reopen*.
 *
 * The harness validates an `assistant/message` twice, and only one of the two
 * happens where this bridge runs. On append it checks the surface transition,
 * which a message without settlement fields passes; on **restore** it also runs
 * `assertAssistantSettlementShape`, which requires `turn`, `step` and `stream`
 * together and refuses the whole session when one is missing. A session written
 * by this bridge therefore looked fine until it was loaded again, and then could
 * not be loaded at all:
 *
 *   `seed assistant/message at index N has invalid settlement fields`
 *
 * That is the reported failure — a session that created (201), held the user's
 * and the model's messages durably, and still could not be reopened. Nothing
 * about it was visible at write time, which is why the regression has to go
 * through a real write, a real persisted log, and a real restore rather than a
 * stand-in that accepts whatever it is handed.
 *
 * The real harness is loaded best-effort from the installed `dsh`, as in
 * `agent-scope.test.mjs`: `@deepseek-ai/dsh-session` is not a dependency of this
 * repository, so the harness block is skipped where `dsh` is absent, and the
 * offline checks below still pin the shape.
 *
 * Evidence for the rule, read from the installed 0.2.0-rc.2:
 * - `@deepseek-ai/dsh-session/lib/index.js:1166` `assertAssistantSettlementShape`
 *   — `turn`/`step` safe integers ≥ 0 and not `-0`, `stream` an array.
 * - `.../lib/index.js:1163` — called for `assistant/message` at the seed/load
 *   boundary (`assertSessionEventEnvelope`), and for `assistant/attempt` at 1158.
 * - `.../lib/types/types.d.ts:330-341` — the `assistant/message` payload shape.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { sessionEventForMessage } from "../../src/host/event-mapping.js";

/** Locate the installed `dsh` package that carries the real harness modules. */
function locateDsh() {
  const candidates = [];
  if (process.env.DSH_INSTALL_ROOT !== undefined) candidates.push(process.env.DSH_INSTALL_ROOT);
  try {
    candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@deepseek-ai", "dsh"));
  } catch {
    // `npm` may be absent; the env override is then the only route.
  }
  return candidates.find((root) =>
    existsSync(join(root, "node_modules", "@deepseek-ai", "dsh-session", "lib", "index.js")),
  );
}

const dshRoot = locateDsh();

/** The real harness modules, loaded by absolute path from the install. */
const real =
  dshRoot === undefined
    ? undefined
    : await (async () => {
        const modules = join(dshRoot, "node_modules", "@deepseek-ai");
        const load = (name) => import(pathToFileURL(join(modules, name, "lib", "index.js")).href);
        const { Context } = await load("cordis");
        const { default: SessionStore, Session } = await load("dsh-session");
        return { Context, SessionStore, Session };
      })();

/** A Core `MessageView`, as `messages.list` returns one. */
function message(overrides = {}) {
  return {
    kind: "assistant",
    text: null,
    entryId: 3,
    messageId: "msg-3",
    toolCallId: null,
    source: null,
    ...overrides,
  };
}

/** The messages of one ordinary turn: a question, an answer, a note and a tool round. */
const TURN_MESSAGES = [
  message({ kind: "user", text: "run it", entryId: 1, messageId: "msg-1" }),
  message({ kind: "assistant", text: "thinking out loud", entryId: 2, messageId: "msg-2" }),
  message({ kind: "tool_call", text: '{"a":1}', entryId: null, messageId: "msg-call", toolCallId: "call_1" }),
  message({ kind: "tool_result", text: "ok", entryId: 4, messageId: "msg-4", toolCallId: "call_1" }),
  // The Core's own note in the transcript — a compaction or observation the
  // bridge records as a developer message. It is not a settlement record and
  // must restore as readily as the messages around it.
  message({ kind: "observation", text: "the run is using tool echo", entryId: 6, messageId: "msg-6", source: "subagent" }),
  message({ kind: "assistant", text: "the answer", entryId: 5, messageId: "msg-5" }),
];

const TURN = 1;
const STEP = 1;

/**
 * Write one turn into a session, the way `ThreadAgent._runTurn` and
 * `ThreadAgent._syncMessages` write it: the turn/step boundaries, then every
 * Core message this session does not hold yet, mapped by the production mapping.
 * @param session - a real or stand-in session with `append`.
 * @param reason - the `turn/end` reason, so a check can write a failed or
 *   cancelled turn as well as a completed one.
 */
function writeTurn(session, reason = { kind: "completed" }) {
  session.append("turn/start", { turn: TURN });
  session.append("step/start", { turn: TURN, step: STEP });
  for (const entry of TURN_MESSAGES) {
    const mapped = sessionEventForMessage(entry, { turn: TURN, step: STEP });
    if (mapped !== null) session.append(mapped.type, mapped.data, mapped.options);
  }
  session.append("step/end", { turn: TURN, step: STEP });
  session.append("turn/end", { turn: TURN, reason });
}

const HEADER = (id) => ({ version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false, cwd: "/tmp/ws" });

describe("the assistant message this bridge records", () => {
  it("carries the settlement fields the harness restores a session by", () => {
    // Both Core kinds that record as `assistant/message` — the model's answer
    // and a delegated agent's — are the same DSH event and need the same fields.
    for (const kind of ["assistant", "agent_message"]) {
      const mapped = sessionEventForMessage(message({ kind, text: "the answer", entryId: 5 }), { turn: 2, step: 3 });

      expect(mapped.type).toBe("assistant/message");
      expect(mapped.data.turn).toBe(2);
      expect(mapped.data.step).toBe(3);
      expect(Array.isArray(mapped.data.stream)).toBe(true);
      expect(mapped.data.stream).toEqual([]);
    }
  });

  it("leaves every other message kind without a stream", () => {
    // One of each remaining kind the mapping knows, plus one it does not. Only
    // `assistant/message` is a settlement record; putting a stream on the
    // others would claim a timing record the harness never asks them for.
    for (const kind of ["user", "tool_call", "tool_result", "system", "core", "compaction", "observation", "something-new"]) {
      const mapped = sessionEventForMessage(message({ kind, text: "x", entryId: 1 }), { turn: TURN, step: STEP });
      expect(mapped.type).not.toBe("assistant/message");
      expect(Object.hasOwn(mapped.data, "stream")).toBe(false);
    }
  });

  it("claims no usage and no interruption it cannot prove", () => {
    // `usage` and `interrupted` are the harness's own facts about a model
    // attempt. This bridge reads a committed message back and knows neither, so
    // it must omit both rather than fill them in.
    const mapped = sessionEventForMessage(message({ text: "the answer", entryId: 5 }), { turn: TURN, step: STEP });

    expect(Object.hasOwn(mapped.data, "usage")).toBe(false);
    expect(Object.hasOwn(mapped.data, "interrupted")).toBe(false);
  });
});

describe.skipIf(dshRoot === undefined)("reopening a session this bridge wrote (real harness)", () => {
  /** Write a turn through a real session, persist it as JSON, and restore it. */
  function writeAndReopen(reason, id) {
    const { Context, SessionStore, Session } = real;
    const root = new Context();
    new SessionStore(root);
    const session = root.sessions.create(id);
    writeTurn(session, reason);

    // The log as storage keeps it: JSON, nothing shared with the live session.
    const persisted = JSON.parse(JSON.stringify(session.snapshotEvents()));
    return { session, persisted, restore: () => Session.fromRestore(id, persisted, HEADER(id), 0, "shared-frozen") };
  }

  it("loads the turn back, with the history it recorded", () => {
    const { session, restore } = writeAndReopen({ kind: "completed" }, "session-settlement-1");
    expect(session.snapshotEvents().map((event) => event.type)).toContain("assistant/message");

    const reopened = restore();

    const types = reopened.snapshotEvents().map((event) => event.type);
    expect(types).toContain("assistant/message");
    expect(types).toContain("tool/result");
    expect(types).toContain("developer/message");
    // The content is what the reopen had to preserve: the answer's own text, and
    // the tool call it made. A stream would only have added timing.
    const answers = reopened
      .snapshotEvents()
      .filter((event) => event.type === "assistant/message")
      .map((event) => event.data.message.content);
    expect(answers).toContainEqual([{ type: "text", text: "the answer" }]);
  });

  it("loads a failed turn and a cancelled turn as readily as a completed one", () => {
    for (const [reason, id] of [
      [{ kind: "failed", reason: "the model refused" }, "session-settlement-failed"],
      [{ kind: "aborted", reason: { kind: "user" } }, "session-settlement-aborted"],
    ]) {
      expect(() => writeAndReopen(reason, id).restore()).not.toThrow();
    }
  });

  it("loads a turn whose answer never arrived", () => {
    // A Run that fails before producing a message records boundaries and no
    // assistant message; the restore must not depend on one being there.
    const { Context, SessionStore, Session } = real;
    const root = new Context();
    new SessionStore(root);
    const session = root.sessions.create("session-settlement-empty");
    session.append("turn/start", { turn: TURN });
    session.append("step/start", { turn: TURN, step: STEP });
    session.append("step/end", { turn: TURN, step: STEP });
    session.append("turn/end", { turn: TURN, reason: { kind: "failed", reason: "no answer" } });
    const persisted = JSON.parse(JSON.stringify(session.snapshotEvents()));

    expect(() => Session.fromRestore("session-settlement-empty", persisted, HEADER("session-settlement-empty"), 0, "shared-frozen")).not.toThrow();
  });

  it("reproduces the reported refusal when the settlement field is dropped", () => {
    // The reverse evidence: this is the shape the bridge used to write, and the
    // exact refusal the user saw. If a future change drops `stream` again, the
    // check above fails and this one still explains why.
    const { persisted, restore } = writeAndReopen({ kind: "completed" }, "session-settlement-2");
    expect(() => restore()).not.toThrow();

    const stripped = persisted.map((event) => {
      if (event.type !== "assistant/message") return event;
      const { stream, ...data } = event.data;
      return { ...event, data };
    });
    const { Session } = real;

    expect(() =>
      Session.fromRestore("session-settlement-2", stripped, HEADER("session-settlement-2"), 0, "shared-frozen"),
    ).toThrow(/seed assistant\/message at index \d+ has invalid settlement fields/);
  });
});
