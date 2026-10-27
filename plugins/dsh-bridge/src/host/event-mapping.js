/**
 * How a Core fact becomes a DSH session event.
 *
 * The two systems describe the same conversation in different words, and this
 * module is the only place that translates between them. It is deliberately
 * pure: given a Core message or a Core committed event it returns the DSH
 * event to append, and it holds no session, no socket and no clock. A mapping
 * that reached for a session could append from two places, and the session log
 * would then depend on which path happened to run first.
 *
 * ## What the mapping can and cannot carry
 *
 * The Core publishes *state* facts as committed events — a Run started, a Run
 * settled, a Thread's gate moved — and it does **not** publish messages that
 * way. Messages are projected from Pi's entries and read back through the
 * message listing, which is why {@link sessionEventForMessage} takes a
 * `MessageView` rather than an event. So the session log is filled from two
 * sources, and both are facts:
 *
 * - the turn's own text, appended by the agent when it submits (the user's
 *   words are the agent's to record — the Core stores them too, and the two are
 *   the same string, not two renderings of one);
 * - the Core's messages, appended as they are read back, keyed by the Core's
 *   own `messageId` so a re-read of the same history does not append it twice.
 *
 * Nothing here invents text. A message whose `text` is `null` carries structure
 * and no body, and is mapped to a message with no text block rather than to an
 * empty string — an empty string would claim the model produced one.
 */

/**
 * The prefix every Core-derived id in this module carries.
 *
 * Shared by the message ids and by the legacy entry markers a log written before
 * the message id was the identity holds, so a reader can tell at a glance which
 * of the two it is looking at.
 */
const CORE_PREFIX = "core-";

/** The key a tool call's identity is remembered by. */
function callKey(callId) {
  return `call:${callId}`;
}

/**
 * A non-empty string, or `null`.
 *
 * The Core's own fields are optional in the shapes this module reads (a
 * `MessageView` read back through a client that did not validate it), and
 * `""` is not an id: it would name a message that exists with no name.
 * @param value - the value to read.
 * @returns the string, or `null` when there is none.
 */
function textOf(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The DSH id one Core message is recorded under.
 *
 * The Core's `messageId` is the message's own identity: it is minted once, it is
 * what the `message.committed` event published, and it does not change when the
 * message's native entry is linked a moment later. The `entryId` is not an
 * identity — one entry can carry several messages (an assistant entry that
 * narrates and then calls two tools is three), so an id derived from it would
 * give those messages one name and the transcript would hold one of them — and
 * an accepted message's `entryId` goes from `null` to a real value without a
 * second event, so an id that switched with it would append the same message
 * twice.
 *
 * The entry form survives only as a last resort, for a record with no
 * `messageId` at all: it is the id this module used to mint, so a log written
 * then still matches the message it holds. It is never reached for a message
 * this Core wrote — `messageId` is a required field of the listing.
 * @param message - a `MessageView` from the Core's message listing.
 * @returns the id, or `null` when the message carries no identity at all.
 */
function messageEventId(message) {
  const messageId = textOf(message?.messageId);
  if (messageId !== null) return `${CORE_PREFIX}${messageId}`;
  const entryId = message?.entryId;
  if (entryId === null || entryId === undefined) return null;
  return `${CORE_PREFIX}entry-${String(entryId)}`;
}

/**
 * The DSH session event types this module produces.
 *
 * They are the ones the harness's own loop writes, so the transcript this
 * bridge builds is one the interface already knows how to draw: nothing here
 * asks the UI to understand a bridge-specific shape.
 */
export const SESSION_EVENT = {
  USER_MESSAGE: "user/message",
  ASSISTANT_MESSAGE: "assistant/message",
  DEVELOPER_MESSAGE: "developer/message",
  TOOL_CALL: "tool/call",
  TOOL_RESULT: "tool/result",
  TURN_START: "turn/start",
  TURN_END: "turn/end",
  STEP_START: "step/start",
  STEP_END: "step/end",
};

/**
 * Which DSH event records a Core message kind, and as whom.
 *
 * Type and role are one entry rather than two tables because the harness
 * validates them *together*: an `assistant/message` whose message carries any
 * other role is refused at append, and so is a `developer/message` whose role
 * is not `developer`. Two tables that could drift would produce events that
 * look right here and are rejected where it matters, so the pairing is stated
 * once.
 *
 * A Core `core` message is the Core's own note in the transcript and has no DSH
 * role of its own; it is recorded as a `developer/message`, which is what the
 * harness calls a message that came from the system side rather than from the
 * user or the model. Anything this build does not know is recorded the same
 * way: a visible note is better than a dropped message, and a wrong role would
 * not be recorded at all.
 */
const RECORDING_BY_KIND = {
  user: { type: SESSION_EVENT.USER_MESSAGE, role: "user" },
  assistant: { type: SESSION_EVENT.ASSISTANT_MESSAGE, role: "assistant" },
  agent_message: { type: SESSION_EVENT.ASSISTANT_MESSAGE, role: "assistant" },
  tool_call: { type: SESSION_EVENT.TOOL_CALL, role: "assistant" },
  tool_result: { type: SESSION_EVENT.TOOL_RESULT, role: "tool" },
  system: { type: SESSION_EVENT.DEVELOPER_MESSAGE, role: "developer" },
  core: { type: SESSION_EVENT.DEVELOPER_MESSAGE, role: "developer" },
  compaction: { type: SESSION_EVENT.DEVELOPER_MESSAGE, role: "developer" },
  observation: { type: SESSION_EVENT.DEVELOPER_MESSAGE, role: "developer" },
};

/** How a message kind this build does not know is recorded. */
const UNKNOWN_RECORDING = { type: SESSION_EVENT.DEVELOPER_MESSAGE, role: "developer" };

/** The DSH event type a Core message is recorded under. */
function recordingFor(kind) {
  return RECORDING_BY_KIND[kind] ?? UNKNOWN_RECORDING;
}

/**
 * The DSH event type a Core message is recorded under.
 * @param kind - the Core's `MessageKind`.
 * @returns the session event type.
 */
export function sessionEventTypeFor(kind) {
  return recordingFor(kind).type;
}

/** The DSH role a Core message kind is recorded as. */
export function sessionRoleFor(kind) {
  return recordingFor(kind).role;
}

/**
 * The `source` a recorded message carries, which the harness reads as well as
 * validates: the session title only takes the user's words from a message whose
 * source kind is `user`, and a tool result must name the call it answers.
 *
 * ## Why the user's own source is carried through
 *
 * A prompt is painted in the interface the moment it is submitted, as a local
 * *submission echo* that the Host keeps in client memory until it sees the same
 * words as a durable event: `PendingSubmission` is documented as "not yet
 * observed as durable events or queue occurrences", and the observation is
 * matched by the prompt's RPC identity — "the durable `user/message` source
 * **echoes** it as `rpcId`" (the Host's own words, and the `user-rpc` variant it
 * declares for this source). A recorded message that drops that identity is
 * never recognised as the echo's durable form, so the interface draws the user's
 * words twice while the session holds them once. The identity is the input's own
 * and is passed in rather than invented here: this function has the Core's
 * `MessageView`, which carries no request of its own, so the only source that
 * can be echoed is the one the input arrived with.
 * @param type - the session event type the message is recorded under.
 * @param message - the Core's `MessageView`.
 * @param id - the message id this mapping minted.
 * @param inputSource - the source the submitted input arrived with, when this
 *   message *is* that input; `null` for every other message.
 * @returns the source object for the message.
 */
function sourceFor(type, message, id, inputSource = null) {
  switch (type) {
    case SESSION_EVENT.USER_MESSAGE:
      // The input's own source, or the bare kind: a message this session did not
      // submit — another client's input, history read back from the Core, a fork
      // carried over — has no submission of its own to correlate with, and
      // naming one would retire an echo that belongs to a different prompt.
      return inputSource ?? { kind: "user" };
    case SESSION_EVENT.ASSISTANT_MESSAGE:
      // The Core's messages carry no provider or model — a Run's answer is the
      // provider's, but the projection does not keep which one. The pair is
      // therefore the bridge's own name, and it is a name rather than a claim
      // about a model that ran.
      return { kind: "model", provider: "super-agent", model: "core" };
    case SESSION_EVENT.TOOL_RESULT: {
      const callId = typeof message.toolCallId === "string" && message.toolCallId !== "" ? message.toolCallId : id;
      return { kind: "tool", callId };
    }
    default:
      // The Core's own word for where the message came from is kept alongside,
      // so a reader can still tell a subagent's note from a tool's.
      return typeof message.source === "string" && message.source !== ""
        ? { kind: "super-agent", origin: message.source }
        : { kind: "super-agent" };
  }
}

/**
 * The source one accepted input is echoed under, when this message is it.
 *
 * The match is the Core's own message id for the input and nothing else: the
 * listing's order, the message's text and when it arrived are all facts about
 * *a* message rather than about *this* input, and a rule that used them would
 * put one prompt's identity on another prompt's words — which retires an echo
 * the user is still waiting on and leaves the words it was holding unaccounted
 * for. A message the Core named no id for is not matched at all.
 * @param input - `{ messageId, source }` for the input the open turn submitted,
 *   or `null` when there is none to claim.
 * @param message - the Core's `MessageView`.
 * @returns the input's source when this message is that input, else `null`.
 */
function inputSourceFor(input, message) {
  if (input === null || input === undefined) return null;
  if (message?.messageId !== input.messageId) return null;
  return input.source ?? null;
}

/**
 * The source the one input of a turn's batch arrived with, or `null`.
 *
 * The Host hands the agent the very message it minted for the prompt, and that
 * message carries the prompt's identity in its own source. It is read here,
 * where the input enters the bridge, because the words are the only part of it
 * that reaches the Core: the id, the source and the correlation the interface
 * needs are all dropped by the time the Core's copy comes back, and the Core
 * cannot be asked for what it was never told.
 *
 * ## One input, or none
 *
 * A batch of several messages becomes **one** Core message — the claimed texts
 * are joined and submitted as one input — so there is no single identity that
 * could stand for all of them: echoing the first would retire the first echo
 * while the others stayed, and echoing each would need as many durable messages
 * as the batch had inputs, which the Core does not write. So a batch that is not
 * exactly one identified message yields `null`, and no claim is made about any
 * of them. A message without a source (a caller that is not the Host) is the
 * same case.
 * @param messages - the claimed input batch, as the Host handed it over.
 * @returns the input's source, to be echoed on the message the acceptance
 *   writes; `null` when the batch is not one identified input's.
 */
export function submittedInputSource(messages) {
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const source = messages[0]?.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
  if (source.kind !== "user") return null;
  if (typeof source.rpcId !== "string" || source.rpcId === "") return null;
  return source;
}

/**
 * One Core message, as the DSH event that records it.
 *
 * The message id is the Core's own `messageId` rather than a counter or the
 * message's native entry: a re-read of the same history must produce the *same*
 * id, or the transcript grows a second copy of a message the user already has,
 * and one entry's several messages must produce *different* ids, or the
 * transcript holds only one of them. See {@link messageEventId}.
 *
 * ## Where the message sits in the payload
 *
 * `user/message` is the one message event whose `data` *is* the message; every
 * other one carries it under `data.message`. That asymmetry is the harness's
 * (`sessionTitleUserMessageOf` reads `event.data.source` directly), and a
 * bridge that nested the user's own words one level deeper is not merely
 * mis-drawn — the title projection reads `undefined.source.kind` and takes the
 * session down with it. `tool/call` is not a message event at all: it carries
 * the call's own fields, and it is the one event here that must *not* carry a
 * `surfaceOp`, because the harness refuses that marker on an event that does
 * not write to the surface.
 * @param message - a `MessageView` from the Core's message listing.
 * @param position - the turn and step the message belongs to.
 * @param input - `{ messageId, source }` for the input the open turn submitted,
 *   when the caller knows it; `null` when it does not. The source is echoed on
 *   the message the Core named and on no other. See {@link inputSourceFor}.
 * @returns `{ type, data, options }` for `session.append`, or `null` for a
 *   message this build does not put in a transcript — a kind it does not know
 *   *is* recorded (see {@link recordingFor}); the only `null` for a well-formed
 *   message is one with no identity to record it under, which this Core's
 *   listing cannot produce.
 */
export function sessionEventForMessage(message, position = {}, input = null) {
  if (message === null || typeof message !== "object") return null;
  const id = messageEventId(message);
  if (id === null) return null;
  const { type, role } = recordingFor(message.kind);
  const content = typeof message.text === "string" && message.text !== ""
    ? [{ type: "text", text: message.text }]
    : [];
  const source = sourceFor(type, message, id, inputSourceFor(input, message));
  const body = {
    id,
    role,
    content,
    source,
    // The harness requires a tool result's message to repeat the call id its
    // source names — the same value in both places, or the append is refused.
    ...(type === SESSION_EVENT.TOOL_RESULT ? { toolCallId: source.callId } : {}),
  };
  if (type === SESSION_EVENT.USER_MESSAGE) {
    return { type, data: body, options: { surfaceOp: "append" } };
  }
  if (type === SESSION_EVENT.TOOL_CALL) {
    // Old records did not retain call details. Keep their explicit bridge
    // placeholder, while new records carry the actual provider call.
    const callId = typeof message.toolCallId === "string" && message.toolCallId !== "" ? message.toolCallId : id;
    return {
      type,
      data: { ...position, callId,
        name: message.toolCall?.name ?? "core_tool_call",
        arguments: message.toolCall?.arguments ?? JSON.stringify(content) },
      options: undefined,
    };
  }
  return {
    type,
    data: {
      ...position,
      message: body,
      // `assistant/message` is the one message event the harness also reads as a
      // *settlement* record, and its restore boundary refuses one that is not
      // settled: `assertAssistantSettlementShape` requires `turn`, `step` and
      // `stream` together, and the failure surfaces only on reopen — the append
      // itself is accepted, so a session is written and then cannot be loaded
      // again ("seed assistant/message at index N has invalid settlement
      // fields"). `turn` and `step` come from `position`; `stream` does not.
      //
      // `stream` is the harness's lossless record of the model's *timing* — one
      // compact entry per delta run, from which it derives first-token time and
      // throughput. This bridge reads messages back from the Core's projection
      // after the fact and holds no per-chunk timing at all, so the only honest
      // value is the empty stream: "no timing is claimed". It is not a dropped
      // body — the message's text is in `content`, which is what the interface
      // renders from; an empty stream only costs the message its timing line.
      // Filling it from the bridge's live frames would claim a fidelity those
      // frames are deliberately lossy about, and inventing usage or a finish
      // reason would be worse still.
      ...(type === SESSION_EVENT.ASSISTANT_MESSAGE ? { stream: [] } : {}),
    },
    options: { surfaceOp: "append" },
  };
}

/**
 * The messages of one conversation that a session has not recorded yet.
 *
 * `seen` is the set of keys the session already holds (see
 * {@link messageIdentityKeys}). It is passed in rather than derived from the
 * session's own log because the log is the harness's and reading it back is a
 * snapshot of everything ever written, which is the wrong size for a question
 * about the last few messages.
 *
 * ## The legacy marker, and how far it reaches
 *
 * A `core-entry-N` key is what a build that keyed messages by their native entry
 * wrote. It can stand in for **one** message of that entry — the single one such
 * a build recorded for it — and no further: the entry is not the message, and a
 * rule that suppressed every message an entry's marker names would lose the tool
 * calls of an entry whose narration an old log already holds. So the marker is
 * spent on the first message of that entry in this read and the rest are new.
 * Which message that is follows from the listing's own order, in which an
 * entry's own message comes before the calls it made.
 * @param messages - the Core's messages, oldest first.
 * @param seen - keys already appended.
 * @returns the new messages, in the order the Core listed them.
 */
export function unseenMessages(messages, seen) {
  const held = seen instanceof Set ? seen : new Set(seen ?? []);
  const legacySpent = new Set();
  return (messages ?? []).filter((message) => {
    if (messageIdentityKeys(message).some((key) => held.has(key))) return false;
    const entryId = message?.entryId;
    if (entryId === null || entryId === undefined) return true;
    const legacy = `${CORE_PREFIX}entry-${String(entryId)}`;
    if (!held.has(legacy) || legacySpent.has(legacy)) return true;
    legacySpent.add(legacy);
    return false;
  });
}

/**
 * The keys one Core message is remembered by, for a transcript that must not
 * record it twice.
 *
 * A message is known by its own Core `messageId`, and that is the whole of its
 * identity — see {@link messageEventId} for why the entry is not one. A
 * `tool_call` is the one kind that is *also* known by its call's id: the DSH
 * transcript records a call under that id, and a session log written before
 * this build keyed messages by their Core id holds no message id for a call at
 * all, only the `callId` its event carried. Remembering the call id is what
 * keeps a restart from appending a call the log already holds.
 * @param message - a `MessageView` from the Core's message listing.
 * @returns the keys to remember, the message's own first.
 */
export function messageIdentityKeys(message) {
  const keys = [];
  const id = messageEventId(message);
  if (id !== null) keys.push(id);
  const originId = textOf(message?.origin?.messageId);
  if (originId !== null) keys.push(`${CORE_PREFIX}${originId}`);
  if (message?.kind === "tool_call") {
    const callId = textOf(message?.toolCallId);
    if (callId !== null) keys.push(callKey(callId));
  }
  return keys;
}

/**
 * What a failed turn's end says, in the contract's own failure variant.
 *
 * `turn/end`'s reason is a merge-extensible map, and its failure member is
 * `error` — there is no `failed` member to write. A reason outside that map is
 * not a reason any reader matches: the interface builds its terminal error row
 * only when `reason.kind === "error"`, reading `reason.error`, so a turn closed
 * as `failed` renders as a turn that simply ended. That is how a Thread creation
 * the Core refused with 400 came to be shown as "Completed" with nothing for the
 * user to act on.
 *
 * The payload is the contract's own flattening for a failure that is not a
 * provider error: `{ message, code: "UNKNOWN" }`, where the code is the map's
 * marker for "no provider code applies" and the message is the words the
 * failure itself came with. `message` is required, so it is never left out —
 * and never invented: the caller passes the text it already has.
 * @param message - the failure's own words, as the Core or the bridge stated it.
 * @returns the `error` reason for `turn/end`.
 */
export function turnErrorReason(message) {
  return { kind: "error", error: { message, code: "UNKNOWN" } };
}

/** What a failed Run says when the Core named no end reason of its own. */
const RUN_FAILED_WITHOUT_REASON = "the Run failed";

/**
 * The cancellation cause of a Run the Core cancelled, in the contract's union.
 *
 * `TurnEndCancelCause` is `{kind:'user'} | {kind:'parent'} | {kind:'hook',reason}
 * | {kind:'disposed'} | {kind:'legacy'}` — a bare string is none of them, and the
 * Core's `endReason` is a bare string, so passing it through would write a cause
 * no reader matches.
 *
 * Which member is honest is read from the Core's own record and nothing else.
 * `user_stop` is the Core saying a user's stop ended this Run, so it maps to
 * `user`. Every other end reason says *why* the Run stopped — a Thread archived,
 * a configuration change, a timeout, a capacity or permission failure — and none
 * of those is a DSH cancellation cause, so the contract's `legacy`, which is what
 * a record with no cause of its own carries, is what is left to say. Nothing is
 * guessed from the fact that the turn ended, and a Run cancelled for a reason
 * this build does not know is recorded as unknown rather than attributed.
 * @param endReason - the Core's `RunEndReason`, when the payload named one.
 * @returns a legal `TurnEndCancelCause`.
 */
function cancelCauseForRunEndReason(endReason) {
  return endReason === "user_stop" ? { kind: "user" } : { kind: "legacy" };
}

/**
 * What a Core committed event means for the DSH turn that is open.
 *
 * Only the Run's own settlement closes a turn. `thread.status_changed` is the
 * gate moving and `input.accepted` is an acknowledgement — neither says the
 * work the turn opened has finished, and closing a turn on either would show
 * the user a completed turn while the Run is still going.
 *
 * The reasons it returns are the contract's own: a failure is the `error`
 * variant (see {@link turnErrorReason}), and a cancellation carries a cause from
 * the union (see {@link cancelCauseForRunEndReason}). Both are stated in the
 * reader's vocabulary rather than the Core's, because the durable record is the
 * interface's and a variant outside its map is a fact it cannot draw.
 * @param event - a committed Core event.
 * @returns `{ kind, reason }` for `turn/end`, or `null` when the event does not
 *   end a turn.
 */
export function turnOutcomeFor(event) {
  const payload = event?.payload ?? {};
  switch (event?.type) {
    case "run.completed":
      return { kind: "completed" };
    case "run.failed":
      // The Core writes the Run's own end reason with the status; the fallback
      // is the event's own fact, for a payload that named none.
      return turnErrorReason(textOf(payload.endReason) ?? textOf(payload.errorRef) ?? RUN_FAILED_WITHOUT_REASON);
    case "run.cancelled":
      return { kind: "aborted", reason: cancelCauseForRunEndReason(payload.endReason) };
    default:
      return null;
  }
}

/**
 * The Run a committed event is about, when it names one.
 *
 * The panel keys its live updates off this: an event that names no Run is a
 * Thread-level fact, and drawing it as a Run update would put a Thread's status
 * change on a card about one Run.
 * @param event - a committed Core event.
 * @returns the Run id, or `null`.
 */
export function runIdOf(event) {
  const payload = event?.payload ?? {};
  const candidate = payload.runId ?? payload.targetRunId;
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

/**
 * A committed event, as the one-line status the panel shows.
 *
 * The wording is the bridge's, not the Core's: the Core's event names are
 * durable vocabulary and a UI that rendered them verbatim would show the user
 * `run.redone`. The *code* is carried through unchanged, so a panel that wants
 * to branch on the fact still can.
 * @param event - a committed Core event.
 * @returns `{ code, text, threadId, runId }`.
 */
export function statusLineFor(event) {
  const runId = runIdOf(event);
  const text = {
    "thread.created": "Thread 已创建",
    "thread.status_changed": "Thread 门禁变化",
    "input.accepted": "输入已受理",
    "run.started": "Run 开始",
    "run.completed": "Run 完成",
    "run.failed": "Run 失败",
    "run.cancelled": "Run 已取消",
    "run.redone": "Run 已重做",
    "conversation.config_changed": "会话配置已更新",
    "wait.answered": "等待已答复",
    "server.ready": "Core 就绪",
    "server.status_changed": "Core 状态变化",
    "server.stopping": "Core 正在停止",
  }[event?.type];
  return {
    code: event?.type ?? "unknown",
    text: text ?? "未知事件",
    threadId: typeof event?.threadId === "string" ? event.threadId : null,
    runId,
  };
}
