/**
 * The durable mapping from a DSH Session to the Core Thread it runs on.
 *
 * A Session id and a Thread id are two different identities from two different
 * systems, and neither can be derived from the other. The native session
 * directory is not a source of business ids: reading it and picking something
 * that looks like a Thread id is a guess, and a guess that is wrong once
 * creates a *second* Thread for a conversation the user is still having. So the
 * pair is written down when the Thread is created and read back from the record
 * afterwards — that is the whole reason this file exists.
 *
 * It lives beside the Core home rather than inside the DSH profile because the
 * two facts have to survive together. A mapping that outlived its Thread would
 * point a session at a Thread that is not there; a Thread that outlived its
 * mapping would be an orphan the user can no longer reach. Keeping them in one
 * home means a home is either restored whole or replaced whole.
 *
 * An entry names the Conversation the session is *showing* as well as the
 * Thread it runs on. The two are the same for an ordinary session — a Thread
 * has one main Conversation and that is what its first session displays — but
 * they come apart the moment a session is opened for a Core fork: a fork is a
 * new Conversation *inside the same Thread*, so a record that named only the
 * Thread would leave the forked session reading the history it was forked away
 * from. The field is optional on read and falls back to the main Conversation,
 * so a file written before forks existed still means exactly what it meant.
 *
 * The write is a whole-file replace through a temporary file, so a crash in the
 * middle leaves the previous mapping rather than a half-written one. That is
 * the same choice the Core's own stores make, and for the same reason: a
 * mapping is small, and a partial one is worse than a stale one.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The file format's version. A record this build does not know is not guessed at. */
export const SESSION_MAP_SCHEMA_VERSION = 1;

/**
 * Where the mapping lives when the caller names nothing.
 *
 * `SUPER_AGENT_HOME` is the Core's own home, and the acceptance runs always set
 * it explicitly. The fallback exists so an interactive run has somewhere to
 * write; it is never reached by a test or by the isolated profile.
 * @param env - the environment to read.
 */
export function defaultSessionMapPath(env = process.env) {
  const home = env.SUPER_AGENT_HOME ?? `${env.HOME ?? "."}/.super-agent`;
  return `${home}/bridge/sessions.json`;
}

/** The shape one entry has on disk, checked field by field. */
function readEntry(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = (value) => (typeof value === "string" && value !== "" ? value : null);
  const sessionId = text(raw.sessionId);
  const threadId = text(raw.threadId);
  const mainConversationId = text(raw.mainConversationId);
  const workspaceId = text(raw.workspaceId);
  const workspaceRoot = text(raw.workspaceRoot);
  const cwd = text(raw.cwd);
  if (
    sessionId === null ||
    threadId === null ||
    mainConversationId === null ||
    workspaceId === null ||
    workspaceRoot === null ||
    cwd === null
  ) {
    return null;
  }
  return Object.freeze({
    sessionId,
    threadId,
    mainConversationId,
    // Absent means "the Thread's main Conversation", which is what every record
    // written before forks existed meant. It is never defaulted on write, so a
    // reader can still tell a recorded fork from an assumed one.
    conversationId: text(raw.conversationId) ?? mainConversationId,
    workspaceId,
    workspaceRoot,
    cwd,
    // Recorded when they are known and `null` when they are not, rather than
    // defaulted: a session that never named a model has not chosen one, and a
    // record that said otherwise would make the next restore claim a choice
    // nobody made.
    agentId: text(raw.agentId),
    modelId: text(raw.modelId),
    createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0,
  });
}

/**
 * Open the mapping file.
 *
 * The whole file is read once, at open, and held in memory: it is a few entries
 * per user, and every read of it happens on a path that is already doing a Core
 * round trip. Writes replace the file and the in-memory copy together, so a
 * `get` after a `put` never disagrees with what is on disk.
 *
 * A file that is absent is an empty mapping — a fresh home, not an error. A
 * file that is present but unreadable or corrupt is *not* silently treated as
 * empty: that would turn "I cannot read which Thread this session is" into
 * "this session has no Thread", which is exactly the guess that creates a
 * duplicate. The caller gets the failure and decides.
 * @param options.path - the mapping file's path.
 * @param options.fs - filesystem seam, for tests.
 * @returns the mapping.
 */
export async function openSessionMap({ path, fs = { mkdir, readFile, rename, writeFile } }) {
  let entries = new Map();
  try {
    const text = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the session map is not an object");
    }
    if (parsed.schemaVersion !== SESSION_MAP_SCHEMA_VERSION) {
      throw new Error(`the session map is schemaVersion ${String(parsed.schemaVersion)}, which this build does not read`);
    }
    if (!Array.isArray(parsed.sessions)) throw new Error("the session map has no sessions list");
    for (const raw of parsed.sessions) {
      const entry = readEntry(raw);
      if (entry === null) throw new Error("the session map holds an entry this build cannot read");
      entries.set(entry.sessionId, entry);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  /** Write the whole mapping, through a temporary file so a crash leaves the old one. */
  const flush = async () => {
    const body = JSON.stringify(
      { schemaVersion: SESSION_MAP_SCHEMA_VERSION, sessions: [...entries.values()] },
      null,
      2,
    );
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${body}\n`, "utf8");
    await fs.rename(temporary, path);
  };

  return {
    path,
    /** The Thread a Session runs on, or `undefined` when it has none yet. */
    get(sessionId) {
      return entries.get(sessionId);
    },
    /** Every mapping, oldest first. */
    all() {
      return [...entries.values()].sort((left, right) => left.createdAt - right.createdAt);
    },
    /**
     * Record a Session's Thread, and write it before returning.
     *
     * Written before it is handed back rather than lazily: the very next thing
     * that happens is a Run on that Thread, and a mapping lost between here and
     * the crash that follows is a duplicate Thread on the next start.
     */
    async put(entry) {
      const checked = readEntry(entry);
      if (checked === null) throw new Error("a session map entry must carry a session, a Thread and a conversation");
      entries.set(checked.sessionId, checked);
      await flush();
      return checked;
    },
    /** Forget one Session. Used when its Thread is gone for good. */
    async remove(sessionId) {
      const existed = entries.delete(sessionId);
      if (existed) await flush();
      return existed;
    },
  };
}
