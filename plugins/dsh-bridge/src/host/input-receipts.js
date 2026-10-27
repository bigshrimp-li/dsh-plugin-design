/**
 * The durable record of what one submitted input became.
 *
 * A prompt arrives from the Host carrying an identity of its own — the RPC id on
 * its source — and leaves the bridge as a Core command. Two facts about that
 * crossing are needed afterwards and neither can be derived again:
 *
 * - **The command.** Which Conversation the input went into, whether it was a
 *   supplement to a Run (`next_turn`) or a Run of its own, and which Run it
 *   joined. Re-deciding those on a second delivery of the same prompt is how one
 *   input becomes two commands: the Run it joined may have settled since, so the
 *   delivery is re-judged as `new_run`, and the Core — which keys idempotency on
 *   the request id *and a hash of the payload* — then refuses a key it already
 *   holds under a different shape instead of answering with the receipt it
 *   wrote. Replaying the recorded command is the same payload, so the Core
 *   answers with the acceptance it already has.
 * - **The message.** The Core names the message an accepted input became on the
 *   receipt, and that id — not the text, not the order, not the arrival time —
 *   is what the transcript's identity is claimed by. The Core's own listing
 *   carries no request, so once the receipt is gone the pairing cannot be
 *   recovered from either side; a record written beside the acceptance is the
 *   only thing that can still say "this message is that prompt's".
 *
 * ## What it is not
 *
 * It holds no text. The words belong to the input the Host delivered, and a
 * replay delivers them again; storing them here would be a second copy of the
 * conversation in a second place. What is stored is the *intent* — a handful of
 * ids and one word — plus the source the input arrived with, which is what the
 * interface retires its own echo against.
 *
 * It lives beside the Session↔Thread mapping, in the same home, for the same
 * reason: these are facts about a home's Threads, and a home is restored whole
 * or replaced whole.
 *
 * ## Its bound
 *
 * One Session's entries are capped, oldest first. The cap is not a correctness
 * boundary but a size one: an entry is a few hundred bytes, and a Session that
 * has submitted thousands of prompts is one where a re-delivery of the oldest is
 * a new submission in every sense that matters. Dropping the oldest entry means
 * a re-delivery of *that* prompt is judged live, exactly as it was before this
 * file existed.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The file format's version. A record this build does not know is not guessed at. */
export const INPUT_RECEIPTS_SCHEMA_VERSION = 1;

/**
 * How many inputs of one Session are remembered.
 *
 * Larger than any conversation's live window and small enough that the file stays
 * a few tens of kilobytes per Session: 200 entries at the size this record has.
 */
export const INPUT_RECEIPTS_PER_SESSION = 200;

/**
 * Where the records live when the caller names nothing.
 *
 * `SUPER_AGENT_HOME` is the Core's own home, and the acceptance runs always set
 * it explicitly. The fallback exists so an interactive run has somewhere to
 * write; it is never reached by a test or by the isolated profile.
 * @param env - the environment to read.
 */
export function defaultInputReceiptsPath(env = process.env) {
  const home = env.SUPER_AGENT_HOME ?? `${env.HOME ?? "."}/.super-agent`;
  return `${home}/bridge/inputs.json`;
}

/** The source an input arrived with, as this file keeps it. */
function readSource(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.kind !== "user") return null;
  if (typeof raw.rpcId !== "string" || raw.rpcId === "") return null;
  return Object.freeze({
    kind: "user",
    rpcId: raw.rpcId,
    ...(typeof raw.clientTimeZone === "string" ? { clientTimeZone: raw.clientTimeZone } : {}),
  });
}

/** The shape one record has on disk, checked field by field. */
function readEntry(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = (value) => (typeof value === "string" && value !== "" ? value : null);
  const sessionId = text(raw.sessionId);
  const rpcId = text(raw.rpcId);
  const requestId = text(raw.requestId);
  const threadId = text(raw.threadId);
  const conversationId = text(raw.conversationId);
  const source = readSource(raw.source);
  if (
    sessionId === null ||
    rpcId === null ||
    requestId === null ||
    threadId === null ||
    conversationId === null ||
    source === null ||
    source.rpcId !== rpcId
  ) {
    return null;
  }
  const delivery = raw.delivery === "next_turn" ? "next_turn" : "new_run";
  // A supplement with no Run to supplement is not a command: the Core refuses a
  // `next_turn` that names no target, so repeating one would be repeating a
  // refusal. The record is not readable rather than quietly re-judged.
  const targetRunId = text(raw.targetRunId);
  if (delivery === "next_turn" && targetRunId === null) return null;
  return Object.freeze({
    sessionId,
    rpcId,
    requestId,
    threadId,
    conversationId,
    delivery,
    // The Run a supplement joined, and the message the acceptance wrote. Both are
    // `null` when they are not known *yet* — the intent is recorded before the
    // Core answers — and are never defaulted on write, so a reader can tell an
    // unknown from a decided one.
    targetRunId: delivery === "next_turn" ? targetRunId : null,
    messageId: text(raw.messageId),
    source,
    createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0,
  });
}

/**
 * Open the record file.
 *
 * The whole file is read once, at open, and held in memory: it is a few hundred
 * small entries per Session, and every read of it happens on a path that is
 * already doing a Core round trip. A write replaces the file *and then* the
 * in-memory copy, so what a reader of this store sees is what is on disk — never
 * a record whose write failed.
 *
 * A file that is absent is an empty record — a fresh home, not an error. A file
 * that is present but unreadable or corrupt is *not* silently treated as empty:
 * that would turn "I cannot read which message this input became" into "this
 * input never had one", which is the guess this file exists to prevent. The
 * caller gets the failure and decides; the callers here decide differently on
 * purpose. A *read of history* — is this durable message one of ours — carries
 * on without the records, because a file the bridge cannot read is no reason to
 * draw less of what the Core already holds. A *delivery* does not: an input that
 * may already have been submitted under this identity is not planned live, since
 * that would re-decide a command that already exists.
 * @param options.path - the record file's path.
 * @param options.fs - filesystem seam, for tests.
 * @param options.limit - how many inputs of one Session to keep.
 * @returns the records.
 */
export async function openInputReceipts({
  path,
  fs = { mkdir, readFile, rename, writeFile },
  limit = INPUT_RECEIPTS_PER_SESSION,
}) {
  /**
   * What a reader sees: least recently written first, so the entry a Session
   * least needs is the one dropped.
   *
   * Both maps are replaced wholesale by a successful write and never edited by
   * one — a write builds the state it would publish beside them — so a read that
   * arrives while the file is being written sees the state the file is in, not
   * half of the one being written. See `put` below.
   */
  let entries = new Map();
  /** The same records by the Core message they became, which is how a read claims one. */
  let byMessage = new Map();
  const keyOf = (entry) => `${entry.sessionId}\u0000${entry.rpcId}`;
  // Keyed by the Conversation as well as the message: a message id is minted
  // inside one Conversation, so that pair is what identifies the message itself,
  // and two Conversations' ids cannot then answer for each other.
  const messageKeyOf = (entry) => `${entry.conversationId}\u0000${entry.messageId}`;
  const add = (map, byMap, entry) => {
    map.set(keyOf(entry), entry);
    if (entry.messageId !== null) byMap.set(messageKeyOf(entry), entry);
  };
  const drop = (map, byMap, entry) => {
    map.delete(keyOf(entry));
    if (entry.messageId !== null && byMap.get(messageKeyOf(entry)) === entry) {
      byMap.delete(messageKeyOf(entry));
    }
  };

  try {
    const text = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the input records are not an object");
    }
    if (parsed.schemaVersion !== INPUT_RECEIPTS_SCHEMA_VERSION) {
      throw new Error(
        `the input records are schemaVersion ${String(parsed.schemaVersion)}, which this build does not read`,
      );
    }
    if (!Array.isArray(parsed.inputs)) throw new Error("the input records have no inputs list");
    for (const raw of parsed.inputs) {
      const entry = readEntry(raw);
      if (entry === null) throw new Error("the input records hold an entry this build cannot read");
      add(entries, byMessage, entry);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  /** Write the whole record, through a temporary file so a crash leaves the old one. */
  const flush = async (state) => {
    const body = JSON.stringify(
      { schemaVersion: INPUT_RECEIPTS_SCHEMA_VERSION, inputs: [...state.entries.values()] },
      null,
      2,
    );
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${body}\n`, "utf8");
    await fs.rename(temporary, path);
  };

  /**
   * The state one write would publish, built beside what readers see.
   *
   * The record added, the one it replaces dropped, the Session's cap applied —
   * all of it on copies, so nothing here is observable until the file holds it.
   * The record that is replaced is dropped before it is added again, which is
   * what keeps the map in write order: the entry a Session least needs is the
   * one it wrote longest ago.
   * @param checked - the record being written.
   * @returns the maps the write would publish.
   */
  const staged = (checked) => {
    const next = new Map(entries);
    const byNext = new Map(byMessage);
    const previous = next.get(keyOf(checked));
    if (previous !== undefined) drop(next, byNext, previous);
    add(next, byNext, checked);
    const mine = [...next.values()].filter((entry) => entry.sessionId === checked.sessionId);
    for (const entry of mine.slice(0, Math.max(0, mine.length - limit))) drop(next, byNext, entry);
    return { entries: next, byMessage: byNext };
  };

  /**
   * The writes, one at a time.
   *
   * One store is opened per home, not per Session, so two Sessions of one home
   * write this file through this one function — and the write is a whole-file
   * replace through a temporary path that is the same for both, because it is
   * derived from the path and the process. Two writes in flight together would
   * therefore interleave in the same temporary file and both try to rename it:
   * the loser renames a file that is no longer there, and whichever body landed
   * last is the one both Sessions' records are read from. Serialising the writes
   * is what makes each one whole.
   */
  let writing = Promise.resolve();

  return {
    path,
    limit,
    /** What this Session's delivery of one RPC id became, or `undefined`. */
    get(sessionId, rpcId) {
      return entries.get(`${sessionId}\u0000${rpcId}`);
    },
    /**
     * The input a Core message is, when this Session recorded one.
     *
     * The message id is the Core's own, minted for the input the acceptance
     * wrote, so a hit is that input and cannot be another: there is no rule here
     * about which message *looks* like the input, and no message is claimed by
     * anything but the id the Core gave.
     *
     * All three of the Session, the Conversation and the id are required to
     * match. The id alone would answer for a Session that never submitted the
     * prompt — and the Conversation is what the id was minted inside, so a
     * record from another line of history cannot claim a message on this one.
     */
    forMessage(sessionId, conversationId, messageId) {
      if (typeof messageId !== "string" || messageId === "") return undefined;
      const entry = byMessage.get(`${conversationId}\u0000${messageId}`);
      return entry !== undefined && entry.sessionId === sessionId ? entry : undefined;
    },
    /**
     * Record an input, and write it before returning.
     *
     * Written rather than kept in memory alone, because the failure this file
     * exists for is the one where the process does not get to write anything
     * afterwards. A record that names no message yet is an intent: it says what
     * the input was submitted as, which is what a second delivery of it must
     * repeat.
     *
     * The file is written *first*, and only a write that reached the file
     * publishes anything: what a reader sees is the state the file is in, before
     * and after. That matters because this store answers questions another turn
     * is acting on — "was this prompt delivered before", "is this message the
     * one it became" — and the answer must not be a record that a failed write
     * never left behind. So the write is built beside the live state (see
     * `staged`), and the two maps are swapped in one step after the flush
     * returns. A failed write therefore has nothing to undo: it changed nothing.
     *
     * Writes are serialised for the same reason — see the queue above — and a
     * failure is this caller's alone, so the next writer still gets its turn.
     */
    put(entry) {
      const checked = readEntry(entry);
      if (checked === null) throw new Error("an input record must carry a session, an RPC id and a command");
      const write = async () => {
        const next = staged(checked);
        await flush(next);
        entries = next.entries;
        byMessage = next.byMessage;
        return checked;
      };
      const queued = writing.then(write, write);
      // The queue keeps going past a failure: one Session's home being full or
      // read-only is that Session's failure, not the next writer's.
      writing = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    /** Every record of one Session, oldest first. */
    all(sessionId) {
      return [...entries.values()].filter((entry) => entry.sessionId === sessionId);
    },
  };
}
