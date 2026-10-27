/**
 * The Core configuration directory layout (design §3.1).
 *
 * These names are part of the interface, not an implementation detail: the
 * client shows `home`, `socketPath` and `lockPath` back to the user, and the
 * dsh bridge reads `run/core.lock` directly to report lock state while the
 * Core is unreachable. Both sides therefore read the layout from here.
 */

/** Home directory used when neither `--home` nor the environment variable is set. */
export const DEFAULT_HOME_DIR_NAME = ".super-agent";

/** Environment variable naming the configuration directory. */
export const HOME_ENV_VAR = "SUPER_AGENT_HOME";

export const RUN_DIR_NAME = "run";
export const LOG_DIR_NAME = "logs";
export const DATA_DIR_NAME = "data";

export const SOCKET_FILE_NAME = "core.sock";
export const LOCK_FILE_NAME = "core.lock";
export const LOG_FILE_NAME = "core.log";

/** Paths relative to the configuration directory, as the interface reports them. */
export const SOCKET_RELATIVE_PATH = `${RUN_DIR_NAME}/${SOCKET_FILE_NAME}`;
export const LOCK_RELATIVE_PATH = `${RUN_DIR_NAME}/${LOCK_FILE_NAME}`;
export const LOG_RELATIVE_PATH = `${LOG_DIR_NAME}/${LOG_FILE_NAME}`;

/**
 * macOS caps `sun_path` at 104 bytes including the terminator. A longer path
 * cannot be bound, so the process fails at startup with an explanation instead
 * of failing later on the first connection.
 */
export const UNIX_SOCKET_PATH_MAX_BYTES = 104;

/** Directory holding the socket and the lock is private to the owner. */
export const RUN_DIR_MODE = 0o700;

export const SOCKET_FILE_MODE = 0o600;
export const LOCK_FILE_MODE = 0o600;

/** Credential storage is never group- or world-readable. */
export const CREDENTIALS_DIR_NAME = "credentials";
export const CREDENTIALS_DIR_MODE = 0o700;
export const CREDENTIAL_FILE_MODE = 0o600;
