import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isPathInside } from "../policy/path-guard.js";
import { processStartTimeMs } from "../browser/cdp-state.js";
import { replaceFileAtomic } from "../shared/atomic-write.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = process.platform === "win32"
  ? 0
  : (fsConstants.O_NOFOLLOW ?? 0);
const STATE_LOCK_FILE = ".wtagent-state.lock";
const persistenceQueues = new Map();

function stateRevision(state) {
  return Number.isSafeInteger(state?.stateRevision)
    && state.stateRevision >= 0
    ? state.stateRevision
    : 0;
}

function sessionStateConflict(message) {
  const error = new Error(message);
  error.code = "SESSION_STATE_CONFLICT";
  return error;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const STATE_LOCK_MUTEX_PREFIX = "WTAGENT_STATE_LOCK_V1 ";

async function openPersistenceLockServer({ port = 0, token }) {
  let responseToken = token;
  const server = net.createServer((socket) => {
    socket.end(`${STATE_LOCK_MUTEX_PREFIX}${responseToken}\n`);
  });
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen({
      host: "127.0.0.1",
      port,
      exclusive: true,
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Could not determine the WTAgent state-lock mutex port.");
  }
  let closed = false;
  return {
    port: address.port,
    setToken(value) {
      responseToken = value;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function persistenceLockMutexPorts(directory) {
  const resolved = path.resolve(directory);
  const ports = new Set();
  for (let index = 0; ports.size < 5; index += 1) {
    const digest = createHash("sha256")
      .update(`${resolved}\0state-lock\0${index}`)
      .digest();
    ports.add(41_000 + (digest.readUInt16BE(0) % 20_000));
  }
  return [...ports];
}

async function acquirePersistenceLockMutex(
  directory,
  token,
  { timeoutMs = 2_000 } = {},
) {
  const mutexPorts = persistenceLockMutexPorts(directory);
  const majority = Math.floor(mutexPorts.length / 2) + 1;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const offset = Math.floor(Math.random() * mutexPorts.length);
    const orderedPorts = mutexPorts.map(
      (_, index) => mutexPorts[(index + offset) % mutexPorts.length],
    );
    const servers = [];
    try {
      for (const port of orderedPorts) {
        try {
          servers.push(await openPersistenceLockServer({ port, token }));
        } catch (error) {
          if (error.code !== "EADDRINUSE") {
            throw error;
          }
          lastError = error;
        }
        if (servers.length >= majority) {
          let closed = false;
          return {
            mutexPorts,
            heldMutexPorts: servers.map((server) => server.port),
            async close() {
              if (closed) {
                return;
              }
              closed = true;
              await Promise.all(servers.map((server) => server.close()));
            },
          };
        }
      }
    } finally {
      if (servers.length < majority) {
        await Promise.all(servers.map((server) => server.close().catch(() => null)));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 11)));
  }

  const error = new Error(
    `Could not acquire the WTAgent session lock mutex: ${lastError?.message ?? "timeout"}`,
  );
  error.code = "SESSION_STATE_LOCKED";
  throw error;
}

async function writePersistenceLockCandidate(candidatePath, {
  token,
  mutexPorts,
  heldMutexPorts,
}) {
  const handle = await fs.open(
    candidatePath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | NO_FOLLOW,
    FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      token,
      mutexPorts,
      heldMutexPorts,
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    if (process.platform !== "win32") {
      await handle.chmod(FILE_MODE);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPersistenceLock(filePath) {
  try {
    await assertSafeFile(filePath);
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function acquirePersistenceLock(
  directory,
  { timeoutMs = 2_000 } = {},
) {
  const filePath = path.join(directory, STATE_LOCK_FILE);
  const token = randomUUID();
  const candidatePath = `${filePath}.${process.pid}.${token}.tmp`;
  const deadline = Date.now() + timeoutMs;
  const lockMutex = await acquirePersistenceLockMutex(
    directory,
    token,
    { timeoutMs },
  );
  let acquired = false;

  try {
    await writePersistenceLockCandidate(candidatePath, {
      token,
      mutexPorts: lockMutex.mutexPorts,
      heldMutexPorts: lockMutex.heldMutexPorts,
    });
    while (Date.now() < deadline) {
      try {
        // A fully initialized inode wins an uncontended lock with one atomic link.
        await fs.link(candidatePath, filePath);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        const existing = await readPersistenceLock(filePath);
        if (!existing) {
          const stillExists = await fs.stat(filePath)
            .then(() => true)
            .catch((statError) => {
              if (statError.code === "ENOENT") {
                return false;
              }
              throw statError;
            });
          if (!stillExists) {
            continue;
          }
          const lockError = new Error(
            `The WTAgent session lock at ${filePath} is malformed; refusing to replace it without a verifiable owner.`,
          );
          lockError.code = "SESSION_STATE_LOCKED";
          throw lockError;
        }

        const existingPid = Number(existing.pid);
        const validExisting = Number.isSafeInteger(existingPid)
          && existingPid > 0
          && typeof existing.token === "string"
          && existing.token.length > 0
          && Number.isFinite(Date.parse(existing.createdAt ?? ""));
        if (!validExisting) {
          const lockError = new Error(
            `The WTAgent session lock at ${filePath} has no verifiable owner.`,
          );
          lockError.code = "SESSION_STATE_LOCKED";
          throw lockError;
        }

        if (processIsAlive(existingPid)) {
          const startedAt = await processStartTimeMs(existingPid)
            .catch(() => null);
          const lockCreatedAt = Date.parse(existing.createdAt);
          const recycled = startedAt != null
            && startedAt > lockCreatedAt + 2_000;
          if (!recycled) {
            const confirmed = await readPersistenceLock(filePath);
            if (confirmed?.token !== existing.token) {
              continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
        }

        const confirmed = await readPersistenceLock(filePath);
        if (confirmed?.token !== existing.token) {
          continue;
        }
        // The quorum mutex remains held across this atomic replacement, so every
        // current-version stale reaper observes either the old or the new inode.
        // Locks from an older format are safe to migrate once their owner is dead.
        await replaceFileAtomic(candidatePath, filePath);
        break;
      }
    }

    const current = await readPersistenceLock(filePath);
    if (current?.token !== token) {
      const error = new Error(
        `Could not acquire the WTAgent session lock at ${filePath}.`,
      );
      error.code = "SESSION_STATE_LOCKED";
      throw error;
    }
    acquired = true;
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        const latest = await readPersistenceLock(filePath);
        if (latest?.token === token) {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        await lockMutex.close();
      }
    };
  } finally {
    await fs.rm(candidatePath, { force: true }).catch(() => null);
    if (!acquired) {
      await lockMutex.close().catch(() => null);
    }
  }
}

function withPersistenceLock(directory, callback) {
  const key = path.resolve(directory);
  const previous = persistenceQueues.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => null)
    .then(async () => {
      const release = await acquirePersistenceLock(key);
      try {
        return await callback();
      } finally {
        await release();
      }
    });
  persistenceQueues.set(key, operation);
  void operation.finally(() => {
    if (persistenceQueues.get(key) === operation) {
      persistenceQueues.delete(key);
    }
  }).catch(() => null);
  return operation;
}

async function chmodOwnerOnly(target, mode) {
  if (process.platform !== "win32") {
    await fs.chmod(target, mode);
  }
}

async function ensureSessionsRoot(sessionsDir) {
  const requested = path.resolve(sessionsDir);
  await fs.mkdir(requested, {
    recursive: true,
    mode: DIRECTORY_MODE,
  });
  await chmodOwnerOnly(requested, DIRECTORY_MODE);

  const root = await fs.realpath(requested);
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) {
    throw new Error(`Sessions path is not a directory: ${root}`);
  }
  return root;
}

async function resolveSessionDirectory(sessionsDir, sessionId) {
  const root = await fs.realpath(path.resolve(sessionsDir));
  const directoryPath = path.join(root, sessionId);
  const lexicalStats = await fs.lstat(directoryPath);

  if (lexicalStats.isSymbolicLink()) {
    throw new Error(`Session directory cannot be a symbolic link: ${directoryPath}`);
  }
  if (!lexicalStats.isDirectory()) {
    throw new Error(`Session path is not a directory: ${directoryPath}`);
  }

  const directory = await fs.realpath(directoryPath);
  if (!isPathInside(root, directory)) {
    throw new Error(`Session directory escapes sessions directory: ${directory}`);
  }

  return { root, directory };
}

async function assertSafeFile(filePath, { allowMissing = false } = {}) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Session file cannot be a symbolic link: ${filePath}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Session path is not a regular file: ${filePath}`);
    }
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await assertSafeFile(filePath, { allowMissing: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;

  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | NO_FOLLOW,
      FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
      await handle.chmod(FILE_MODE);
    }
    await handle.sync();
    await handle.close();
    handle = null;

    await replaceFileAtomic(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function appendOwnerOnly(filePath, content) {
  await assertSafeFile(filePath, { allowMissing: true });
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY
      | fsConstants.O_APPEND
      | fsConstants.O_CREAT
      | NO_FOLLOW,
    FILE_MODE,
  );

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Session path is not a regular file: ${filePath}`);
    }
    if (process.platform !== "win32") {
      await handle.chmod(FILE_MODE);
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateOwnerOnly(filePath, length) {
  await assertSafeFile(filePath);
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | NO_FOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Session path is not a regular file: ${filePath}`);
    }
    await handle.truncate(length);
    if (process.platform !== "win32") {
      await handle.chmod(FILE_MODE);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonlRecords(filePath, {
  allowMissing = false,
  repairTrailing = false,
} = {}) {
  let bytes;
  try {
    await assertSafeFile(filePath);
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") {
      return { records: [], needsLeadingNewline: false };
    }
    throw error;
  }

  const raw = bytes.toString("utf8");
  const terminalNewline = bytes.length === 0 || bytes.at(-1) === 0x0a;
  const lines = raw.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      const trailingPartial = !terminalNewline && index === lines.length - 1;
      if (!trailingPartial) {
        throw error;
      }
      if (repairTrailing) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        await truncateOwnerOnly(filePath, lastNewline < 0 ? 0 : lastNewline + 1);
      }
      return {
        records,
        needsLeadingNewline: false,
        trailingPartial: true,
      };
    }
  }
  return {
    records,
    needsLeadingNewline: !terminalNewline && raw.trim().length > 0,
    trailingPartial: false,
  };
}

function rolloutFileName(createdAt, sessionId) {
  const stamp = createdAt.replaceAll(":", "-");
  return `rollout-${stamp}-${sessionId}.jsonl`;
}

function sessionMetaRecord(state) {
  return {
    timestamp: state.createdAt,
    type: "session_meta",
    payload: {
      id: state.sessionId,
      session_id: state.sessionId,
      timestamp: state.createdAt,
      cwd: state.projectRoot,
      originator: "wtagent",
      source: "wtagent",
      base_instructions: null,
    },
  };
}

export class AgentSession {
  constructor({
    sessionsDir,
    directory,
    state,
    stateFileName = "session.json",
    persistedRevision = stateRevision(state),
  }) {
    this.sessionsDir = sessionsDir;
    this.directory = directory;
    this.state = state;
    this.sessionIdentifier = state.sessionId;
    this.stateFileName = stateFileName;
    this.persistedRevision = persistedRevision;
    this.persistenceQueue = Promise.resolve();
  }

  static async create({ sessionsDir, tasksDir, task, projectRoot, mode, provider = "chatgpt" }) {
    const root = await ensureSessionsRoot(sessionsDir ?? tasksDir);
    const sessionId = `session_${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const directory = path.join(root, sessionId);
    await fs.mkdir(directory, { mode: DIRECTORY_MODE });
    await chmodOwnerOnly(directory, DIRECTORY_MODE);

    const now = new Date().toISOString();
    const state = {
      sessionId,
      task,
      projectRoot: path.resolve(projectRoot),
      provider,
      mode,
      phase: "idle",
      turn: 0,
      runCount: 0,
      conversationUrl: null,
      conversationTargetId: null,
      lastUserMessageId: null,
      lastAssistantMessageId: null,
      pendingOutbound: null,
      pendingAssistantTurn: null,
      activeMode: null,
      stateRevision: 0,
      createdAt: now,
      updatedAt: now,
      rolloutFile: rolloutFileName(now, sessionId),
      completedTools: {},
      sideEffectTools: {},
      pendingToolResult: null,
      followUps: [],
      lastMessage: null,
      lastError: null,
    };
    const session = new AgentSession({
      sessionsDir: root,
      directory,
      state,
      persistedRevision: null,
    });
    await session.save();
    await appendOwnerOnly(
      path.join(directory, state.rolloutFile),
      `${JSON.stringify(sessionMetaRecord(state))}\n`,
    );
    await session.appendEvent("session.created", {
      task,
      projectRoot: state.projectRoot,
      provider,
      mode,
    });
    return session;
  }

  static async load({ sessionsDir, tasksDir, sessionId, taskId }) {
    const identifier = sessionId ?? taskId;
    const rootDirectory = sessionsDir ?? tasksDir;
    if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
      throw new Error(`Invalid session ID: ${identifier}`);
    }

    const { root, directory } = await resolveSessionDirectory(
      rootDirectory,
      identifier,
    );
    let stateFileName = "session.json";
    let statePath = path.join(directory, stateFileName);
    try {
      await assertSafeFile(statePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      stateFileName = "task.json";
      statePath = path.join(directory, stateFileName);
    }
    await assertSafeFile(statePath);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));

    state.sessionId ??= state.taskId;
    if (state.sessionId !== identifier) {
      throw new Error(
        `Session ID mismatch: expected ${identifier}, found ${String(state.sessionId)}`,
      );
    }

    state.phase ??= ["completed", "paused"].includes(state.status)
      ? "idle"
      : (state.status ?? "idle");
    state.provider ??= "chatgpt";
    state.runCount ??= 0;
    state.conversationTargetId ??= null;
    state.lastUserMessageId ??= null;
    state.lastAssistantMessageId ??= null;
    state.pendingOutbound ??= null;
    state.pendingAssistantTurn ??= null;
    state.activeMode ??= null;
    state.stateRevision = stateRevision(state);
    state.rolloutFile ??= "transcript.jsonl";
    state.lastMessage ??= state.finalMessage ?? null;
    state.completedTools ??= {};
    state.sideEffectTools ??= {};
    state.pendingToolResult ??= null;
    state.followUps ??= [];
    return new AgentSession({
      sessionsDir: root,
      directory,
      state,
      stateFileName,
      persistedRevision: state.stateRevision,
    });
  }

  static async list({ sessionsDir, tasksDir, limit = 20 }) {
    const rootDirectory = sessionsDir ?? tasksDir;
    const entries = await fs.readdir(rootDirectory, { withFileTypes: true })
      .catch((error) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
    const states = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) {
        continue;
      }
      try {
        const session = await AgentSession.load({
          sessionsDir: rootDirectory,
          sessionId: entry.name,
        });
        states.push(session.state);
      } catch {
        // Ignore incomplete, corrupt, or unsafe session directories in listings.
      }
    }

    return states
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  get sessionId() {
    return this.sessionIdentifier;
  }

  // Backward-compatible alias for integrations created before sessions became
  // the primary lifecycle entity.
  get taskId() {
    return this.sessionIdentifier;
  }

  async validateDirectory() {
    if (this.state.sessionId !== this.sessionIdentifier) {
      throw new Error("Session ID cannot be changed after creation.");
    }

    const { root, directory } = await resolveSessionDirectory(
      this.sessionsDir,
      this.sessionIdentifier,
    );
    if (root !== this.sessionsDir || directory !== this.directory) {
      throw new Error(`Session directory identity changed: ${this.directory}`);
    }
  }

  #queuePersistenceOperation(callback) {
    const operation = this.persistenceQueue
      .catch(() => null)
      .then(() => withPersistenceLock(this.directory, callback));
    this.persistenceQueue = operation;
    return operation;
  }

  async #readPersistedStateLocked() {
    const statePath = path.join(this.directory, this.stateFileName);
    try {
      await assertSafeFile(statePath);
      return JSON.parse(await fs.readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #assertPersistedRevisionLocked() {
    await this.validateDirectory();
    const persisted = await this.#readPersistedStateLocked();
    const expectedRevision = this.persistedRevision;
    if (expectedRevision == null) {
      if (persisted != null) {
        throw sessionStateConflict(
          "Session state appeared while creating its initial checkpoint.",
        );
      }
      return;
    }

    const persistedId = persisted?.sessionId ?? persisted?.taskId ?? null;
    if (
      persisted == null
      || persistedId !== this.sessionIdentifier
      || stateRevision(persisted) !== expectedRevision
    ) {
      throw sessionStateConflict(
        `Session state changed on disk before revision ${expectedRevision} could be saved.`,
      );
    }
  }

  async #saveSnapshotLocked(snapshot) {
    await this.#assertPersistedRevisionLocked();
    const nextRevision = (this.persistedRevision ?? 0) + 1;
    snapshot.stateRevision = nextRevision;
    await writeJsonAtomic(
      path.join(this.directory, this.stateFileName),
      snapshot,
    );
    this.persistedRevision = nextRevision;
    this.state.stateRevision = nextRevision;
  }

  async #mutateState(callback) {
    return await this.#queuePersistenceOperation(async () => {
      await this.#assertPersistedRevisionLocked();
      const nextState = structuredClone(this.state);
      const result = await callback(nextState);
      await this.#saveSnapshotLocked(nextState);
      this.state = nextState;
      return result;
    });
  }

  async update(patch) {
    const requested = structuredClone(patch);
    await this.#mutateState((nextState) => {
      Object.assign(nextState, requested, {
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async save() {
    // Navigation callbacks and Runtime checkpoints can update the same Session
    // concurrently. The instance queue preserves call order; the owner-only
    // interprocess lock plus persisted revision prevents a separately loaded,
    // stale AgentSession from replacing a newer checkpoint on disk.
    return await this.#queuePersistenceOperation(
      () => this.#saveSnapshotLocked(structuredClone(this.state)),
    );
  }

  async appendEvent(type, payload = {}) {
    await this.validateDirectory();
    const event = {
      type,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      payload,
    };
    await appendOwnerOnly(
      path.join(this.directory, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
    );
    return event;
  }

  async hasEvent(type) {
    await this.validateDirectory();
    const eventsPath = path.join(this.directory, "events.jsonl");
    let raw;
    try {
      await assertSafeFile(eventsPath);
      raw = await fs.readFile(eventsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      if (JSON.parse(line).type === type) {
        return true;
      }
    }
    return false;
  }

  async appendToolOutput(payload) {
    await this.validateDirectory();
    const record = {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    await appendOwnerOnly(
      path.join(this.directory, "tool-output.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    return record;
  }

  #queueTranscriptOperation(callback) {
    return this.#queuePersistenceOperation(callback);
  }

  #transcriptPath() {
    return path.join(this.directory, this.state.rolloutFile);
  }

  #validateTranscriptIdempotencyKey(idempotencyKey) {
    if (
      typeof idempotencyKey !== "string"
      || idempotencyKey.length === 0
      || idempotencyKey.length > 512
      || /[\0\r\n]/.test(idempotencyKey)
    ) {
      throw new Error("A non-empty transcript idempotency key is required.");
    }
  }

  async #appendTranscriptItemLocked(item, { kind = "response_item" } = {}) {
    await this.validateDirectory();
    const transcriptPath = this.#transcriptPath();
    const state = await readJsonlRecords(transcriptPath, {
      allowMissing: true,
      repairTrailing: true,
    });
    const record = {
      timestamp: new Date().toISOString(),
      type: kind,
      payload: JSON.parse(JSON.stringify(item)),
    };
    await appendOwnerOnly(
      transcriptPath,
      `${state.needsLeadingNewline ? "\n" : ""}${JSON.stringify(record)}\n`,
    );
    return record;
  }

  async #appendTranscriptItemOnceLocked(item, {
    idempotencyKey,
    kind = "response_item",
  }) {
    this.#validateTranscriptIdempotencyKey(idempotencyKey);
    await this.validateDirectory();
    const transcriptPath = this.#transcriptPath();
    const state = await readJsonlRecords(transcriptPath, {
      allowMissing: true,
      repairTrailing: true,
    });
    const payload = JSON.parse(JSON.stringify(item));
    const matching = state.records.filter((record) => (
      record?.wtagent?.idempotencyKey === idempotencyKey
    ));
    if (matching.length > 0) {
      const identical = matching.every((record) => (
        record.type === kind
        && isDeepStrictEqual(record.payload ?? record.item, payload)
      ));
      if (!identical) {
        throw new Error(
          `Transcript idempotency key collision: ${idempotencyKey}`,
        );
      }
      return matching[0];
    }

    const record = {
      timestamp: new Date().toISOString(),
      type: kind,
      wtagent: { idempotencyKey },
      payload,
    };
    await appendOwnerOnly(
      transcriptPath,
      `${state.needsLeadingNewline ? "\n" : ""}${JSON.stringify(record)}\n`,
    );
    return record;
  }

  // Appends one canonical transcript item directly to this conversation's
  // Codex rollout JSONL. The XML sent to ChatGPT Web is transport-only.
  async appendTranscriptItem(item, {
    kind = "response_item",
    idempotencyKey = null,
  } = {}) {
    if (idempotencyKey != null) {
      return await this.appendTranscriptItemOnce(item, {
        kind,
        idempotencyKey,
      });
    }
    return await this.#queueTranscriptOperation(
      () => this.#appendTranscriptItemLocked(item, { kind }),
    );
  }

  async appendTranscriptItemOnce(item, {
    idempotencyKey,
    kind = "response_item",
  } = {}) {
    this.#validateTranscriptIdempotencyKey(idempotencyKey);
    return await this.#queueTranscriptOperation(
      () => this.#appendTranscriptItemOnceLocked(item, {
        kind,
        idempotencyKey,
      }),
    );
  }

  async #readTranscriptLocked() {
    await this.validateDirectory();
    const {
      records,
      trailingPartial = false,
    } = await readJsonlRecords(this.#transcriptPath(), {
      allowMissing: true,
    });

    const items = [];
    let storedMeta = null;
    for (const record of records) {
      if (record.type === "session_meta") {
        storedMeta = record.payload ?? null;
        continue;
      }
      if (record.type === "response_item") {
        items.push({
          timestamp: record.timestamp,
          item: record.payload ?? record.item,
          ...(record.wtagent?.idempotencyKey
            ? { idempotencyKey: record.wtagent.idempotencyKey }
            : {}),
        });
      }
    }
    return {
      meta: this.#transcriptMeta(storedMeta),
      items,
      trailingPartial,
    };
  }

  // Reads the conversation rollout as { meta, items } for portable exporters.
  async readTranscript({ allowTrailingPartial = false } = {}) {
    const transcript = await this.#queueTranscriptOperation(
      () => this.#readTranscriptLocked(),
    );
    if (transcript.trailingPartial && !allowTrailingPartial) {
      const error = new Error(
        "The canonical transcript ends with an incomplete JSONL record from an interrupted write.",
      );
      error.code = "TRANSCRIPT_INCOMPLETE";
      throw error;
    }
    return transcript;
  }

  #transcriptMeta(storedMeta = null) {
    return {
      sessionId: storedMeta?.id
        ?? storedMeta?.session_id
        ?? this.state.sessionId,
      cwd: storedMeta?.cwd ?? this.state.projectRoot,
      createdAt: storedMeta?.timestamp ?? this.state.createdAt,
      baseInstructions: storedMeta?.base_instructions ?? null,
      task: this.state.task,
      mode: this.state.mode,
    };
  }

  async commitPendingOutboundHandoff({ outboundId, handoff = {} }) {
    if (typeof outboundId !== "string" || outboundId.length === 0) {
      throw new Error("A pending outbound ID is required for assistant handoff.");
    }
    return await this.#queuePersistenceOperation(async () => {
      // Hold one interprocess lock from the persisted-revision check through all
      // transcript appends and the state swap. A competing writer can neither
      // supersede the outbound between those steps nor inherit transcript items
      // from a handoff whose compare-and-swap failed.
      await this.#assertPersistedRevisionLocked();
      const existingHandoff = this.state.pendingAssistantTurn;
      if (
        this.state.pendingOutbound?.outboundId !== outboundId
        && existingHandoff?.sourceOutboundId === outboundId
      ) {
        return structuredClone(existingHandoff);
      }
      if (this.state.pendingOutbound?.outboundId !== outboundId) {
        throw new Error(
          `Pending outbound changed before assistant handoff: ${outboundId}`,
        );
      }

      const transcriptItems = Array.isArray(
        this.state.pendingOutbound.transcriptItems,
      )
        ? structuredClone(this.state.pendingOutbound.transcriptItems)
        : [];
      for (let index = 0; index < transcriptItems.length; index += 1) {
        const entry = transcriptItems[index];
        const item = entry?.item ?? entry;
        const kind = entry?.item
          ? (entry.kind ?? "response_item")
          : "response_item";
        await this.#appendTranscriptItemOnceLocked(item, {
          kind,
          idempotencyKey: `outbound:${outboundId}:transcript:${index}`,
        });
      }

      const currentOutbound = this.state.pendingOutbound;
      if (currentOutbound?.outboundId !== outboundId) {
        throw new Error(
          `Pending outbound changed while committing assistant handoff: ${outboundId}`,
        );
      }
      const now = new Date().toISOString();
      const requested = structuredClone(handoff);
      const pendingAssistantTurn = {
        ...requested,
        version: 1,
        handoffId: `outbound:${outboundId}`,
        sourceOutboundId: outboundId,
        outboundKind: currentOutbound.kind ?? "runtime_message",
        runtimeTurn: Number.isSafeInteger(requested.runtimeTurn)
          ? requested.runtimeTurn
          : this.state.turn,
        status: "waiting",
        conversationUrl: requested.conversationUrl
          ?? this.state.conversationUrl
          ?? null,
        conversationTargetId: requested.conversationTargetId
          ?? this.state.conversationTargetId
          ?? null,
        userMessageId: requested.userMessageId ?? null,
        userTurn: requested.userTurn ?? null,
        assistantBaseline: requested.assistantBaseline ?? null,
        pendingToolAcknowledgement:
          requested.pendingToolAcknowledgement ?? null,
        createdAt: requested.createdAt ?? now,
        updatedAt: now,
      };
      const nextState = {
        ...structuredClone(this.state),
        pendingOutbound: null,
        pendingAssistantTurn,
        conversationUrl: pendingAssistantTurn.conversationUrl,
        conversationTargetId: pendingAssistantTurn.conversationTargetId,
        ...(pendingAssistantTurn.userMessageId
          ? { lastUserMessageId: pendingAssistantTurn.userMessageId }
          : {}),
        updatedAt: now,
      };
      await this.#saveSnapshotLocked(nextState);
      this.state = nextState;
      return structuredClone(pendingAssistantTurn);
    });
  }

  async refreshPendingAssistantTurn(handoffId, patch = {}) {
    const requested = structuredClone(patch);
    const protectedKeys = new Set([
      "version",
      "handoffId",
      "sourceOutboundId",
      "outboundKind",
      "runtimeTurn",
      "status",
      "createdAt",
      "rawResponse",
      "responseHash",
    ]);
    if (Object.keys(requested).some((key) => protectedKeys.has(key))) {
      throw new Error("Assistant handoff refresh contains protected fields.");
    }
    return await this.#mutateState((nextState) => {
      const current = nextState.pendingAssistantTurn;
      if (!current || current.handoffId !== handoffId) {
        throw new Error(
          `Pending assistant handoff changed before refresh: ${handoffId}`,
        );
      }
      if (!["waiting", "complete"].includes(current.status)) {
        throw new Error(
          `Invalid pending assistant handoff status: ${String(current.status)}`,
        );
      }
      const now = new Date().toISOString();
      const refreshed = {
        ...current,
        ...requested,
        updatedAt: now,
      };
      nextState.pendingAssistantTurn = refreshed;
      if (refreshed.conversationUrl) {
        nextState.conversationUrl = refreshed.conversationUrl;
      }
      if (refreshed.conversationTargetId) {
        nextState.conversationTargetId = refreshed.conversationTargetId;
      }
      if (refreshed.userMessageId) {
        nextState.lastUserMessageId = refreshed.userMessageId;
      }
      nextState.updatedAt = now;
      return structuredClone(refreshed);
    });
  }

  async completePendingAssistantTurn({
    handoffId,
    assistantMessageId = null,
    assistantTurn = null,
    rawResponse,
    completedAt = new Date().toISOString(),
  }) {
    if (typeof rawResponse !== "string") {
      throw new Error("A raw assistant response is required for completion.");
    }
    const responseHash = createHash("sha256")
      .update(rawResponse)
      .digest("hex");
    const completion = {
      assistantMessageId,
      assistantTurn,
      rawResponse,
      responseHash,
    };
    return await this.#mutateState((nextState) => {
      const current = nextState.pendingAssistantTurn;
      if (!current || current.handoffId !== handoffId) {
        throw new Error(
          `Pending assistant handoff changed before completion: ${handoffId}`,
        );
      }
      if (current.status === "complete") {
        const existing = {
          assistantMessageId: current.assistantMessageId ?? null,
          assistantTurn: current.assistantTurn ?? null,
          rawResponse: current.rawResponse,
          responseHash: current.responseHash,
        };
        if (!isDeepStrictEqual(existing, completion)) {
          throw new Error(
            `Assistant handoff completion collision: ${handoffId}`,
          );
        }
        return structuredClone(current);
      }
      if (current.status !== "waiting") {
        throw new Error(
          `Invalid pending assistant handoff status: ${String(current.status)}`,
        );
      }

      const completed = {
        ...current,
        ...completion,
        status: "complete",
        completedAt,
        updatedAt: completedAt,
      };
      nextState.pendingAssistantTurn = completed;
      // Null is authoritative: retaining an older ID could falsely correlate stale
      // history after a provider completed a reply without exposing identity.
      nextState.lastAssistantMessageId = assistantMessageId;
      nextState.updatedAt = completedAt;
      return structuredClone(completed);
    });
  }

  async clearPendingAssistantTurn(handoffId, patch = {}) {
    const requested = structuredClone(patch);
    const protectedKeys = new Set([
      "pendingAssistantTurn",
      "pendingOutbound",
      "sessionId",
    ]);
    if (Object.keys(requested).some((key) => protectedKeys.has(key))) {
      throw new Error("Assistant handoff terminal patch contains protected state.");
    }
    await this.#mutateState((nextState) => {
      const current = nextState.pendingAssistantTurn;
      if (!current || current.handoffId !== handoffId) {
        throw new Error(
          `Pending assistant handoff changed before clearing: ${handoffId}`,
        );
      }
      Object.assign(nextState, requested, {
        pendingAssistantTurn: null,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  getToolResult(fingerprint) {
    return this.state.completedTools[fingerprint]?.result ?? null;
  }

  getSideEffectTool(operationKey) {
    return this.state.sideEffectTools[operationKey] ?? null;
  }

  async claimSideEffectTool(identity) {
    const requested = structuredClone(identity);
    await this.#mutateState((nextState) => {
      const existing = nextState.sideEffectTools[requested.operationKey];
      if (existing) {
        throw new Error(
          `Tool operation is already claimed: ${requested.operationKey}`,
        );
      }

      const claimedAt = new Date().toISOString();
      nextState.sideEffectTools[requested.operationKey] = {
        ...requested,
        status: "running",
        claimedAt,
        updatedAt: claimedAt,
        result: null,
      };
    });
    return await this.appendEvent("tool.claimed", {
      identity: requested,
    });
  }

  async recordToolResult(fingerprint, result, { identity = null } = {}) {
    const storedResult = structuredClone(result);
    const storedIdentity = identity ? structuredClone(identity) : null;
    await this.#mutateState((nextState) => {
      const completedAt = new Date().toISOString();
      nextState.completedTools[fingerprint] = {
        completedAt,
        result: storedResult,
      };

      if (storedIdentity) {
        const existing = nextState.sideEffectTools[storedIdentity.operationKey];
        if (!existing || existing.fingerprint !== storedIdentity.fingerprint) {
          throw new Error(
            `Tool operation changed before completion: ${storedIdentity.operationKey}`,
          );
        }
        nextState.sideEffectTools[storedIdentity.operationKey] = {
          ...existing,
          status: "completed",
          completedAt,
          updatedAt: completedAt,
          result: storedResult,
        };
      }

      nextState.pendingToolResult = storedResult;
    });
    return await this.appendEvent("tool.completed", {
      fingerprint,
      result: storedResult,
    });
  }

  async markSideEffectToolUnknown(identity, result) {
    const storedIdentity = structuredClone(identity);
    const storedResult = structuredClone(result);
    await this.#mutateState((nextState) => {
      const existing = nextState.sideEffectTools[storedIdentity.operationKey];
      if (!existing || existing.fingerprint !== storedIdentity.fingerprint) {
        throw new Error(
          `Tool operation changed before unknown completion: ${storedIdentity.operationKey}`,
        );
      }

      const unknownAt = new Date().toISOString();
      nextState.sideEffectTools[storedIdentity.operationKey] = {
        ...existing,
        status: "unknown",
        unknownAt,
        updatedAt: unknownAt,
        result: storedResult,
      };
      nextState.pendingToolResult = storedResult;
    });
    return await this.appendEvent("tool.completion_unknown", {
      identity: storedIdentity,
      result: storedResult,
    });
  }

  async setPendingToolResult(result) {
    await this.update({ pendingToolResult: result });
  }

  async clearPendingToolResult() {
    await this.update({ pendingToolResult: null });
  }

  async appendInstruction(instruction, { files = [] } = {}) {
    const item = {
      instruction,
      createdAt: new Date().toISOString(),
    };
    if (files.length > 0) {
      item.attachments = files.map((file) => ({
        name: file.name ?? null,
        path: file.path ?? null,
      }));
    }
    await this.#mutateState((nextState) => {
      nextState.followUps.push(structuredClone(item));
      nextState.lastError = null;
    });
    await this.appendEvent("session.instruction_added", item);
  }

  async recoverInterruptedSideEffects() {
    await this.#mutateState((nextState) => {
      for (const [operationKey, entry] of Object.entries(
        nextState.sideEffectTools,
      )) {
        if (entry.status !== "running") {
          continue;
        }
        const result = {
          callId: entry.callId,
          name: entry.name,
          operationSignature: entry.requestSignature,
          ok: false,
          message:
            "This tool operation may have started before the local process was interrupted. "
            + "Its completion is unknown, so it will not be replayed automatically. "
            + "Inspect local state before issuing a deliberate follow-up operation.",
          meta: {
            completionUnknown: true,
            recoverable: true,
          },
        };
        const now = new Date().toISOString();
        nextState.sideEffectTools[operationKey] = {
          ...entry,
          status: "unknown",
          unknownAt: now,
          updatedAt: now,
          result,
        };
        nextState.pendingToolResult ??= result;
      }
    });
  }
}

// Compatibility export for callers using the pre-session class name.
export { AgentSession as TaskSession };
