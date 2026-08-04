import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPathInside } from "../policy/path-guard.js";
import { replaceFileAtomic } from "../shared/atomic-write.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = process.platform === "win32"
  ? 0
  : (fsConstants.O_NOFOLLOW ?? 0);

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
  constructor({ sessionsDir, directory, state, stateFileName = "session.json" }) {
    this.sessionsDir = sessionsDir;
    this.directory = directory;
    this.state = state;
    this.sessionIdentifier = state.sessionId;
    this.stateFileName = stateFileName;
  }

  static async create({ sessionsDir, tasksDir, task, projectRoot, mode }) {
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
      mode,
      phase: "idle",
      turn: 0,
      runCount: 0,
      conversationUrl: null,
      lastAssistantMessageId: null,
      activeMode: null,
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
    });
    await session.save();
    await appendOwnerOnly(
      path.join(directory, state.rolloutFile),
      `${JSON.stringify(sessionMetaRecord(state))}\n`,
    );
    await session.appendEvent("session.created", {
      task,
      projectRoot: state.projectRoot,
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
    state.runCount ??= 0;
    state.lastAssistantMessageId ??= null;
    state.activeMode ??= null;
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

  async update(patch) {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() });
    await this.save();
  }

  async save() {
    await this.validateDirectory();
    await writeJsonAtomic(
      path.join(this.directory, this.stateFileName),
      this.state,
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

  // Appends one canonical transcript item directly to this conversation's
  // Codex rollout JSONL. The XML sent to ChatGPT Web is transport-only.
  async appendTranscriptItem(item, { kind = "response_item" } = {}) {
    await this.validateDirectory();
    const record = {
      timestamp: new Date().toISOString(),
      type: kind,
      payload: item,
    };
    await appendOwnerOnly(
      path.join(this.directory, this.state.rolloutFile),
      `${JSON.stringify(record)}\n`,
    );
    return record;
  }

  // Reads the conversation rollout as { meta, items } for portable exporters.
  async readTranscript() {
    await this.validateDirectory();
    const transcriptPath = path.join(this.directory, this.state.rolloutFile);
    let raw;
    try {
      await assertSafeFile(transcriptPath);
      raw = await fs.readFile(transcriptPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { meta: this.#transcriptMeta(), items: [] };
      }
      throw error;
    }

    const items = [];
    let storedMeta = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const record = JSON.parse(line);
      if (record.type === "session_meta") {
        storedMeta = record.payload ?? null;
        continue;
      }
      if (record.type === "response_item") {
        items.push({
          timestamp: record.timestamp,
          item: record.payload ?? record.item,
        });
      }
    }
    return { meta: this.#transcriptMeta(storedMeta), items };
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

  getToolResult(fingerprint) {
    return this.state.completedTools[fingerprint]?.result ?? null;
  }

  getSideEffectTool(operationKey) {
    return this.state.sideEffectTools[operationKey] ?? null;
  }

  async claimSideEffectTool(identity) {
    const existing = this.getSideEffectTool(identity.operationKey);
    if (existing) {
      throw new Error(
        `Tool operation is already claimed: ${identity.operationKey}`,
      );
    }

    const claimedAt = new Date().toISOString();
    this.state.sideEffectTools[identity.operationKey] = {
      ...identity,
      status: "running",
      claimedAt,
      updatedAt: claimedAt,
      result: null,
    };
    await this.save();
    return await this.appendEvent("tool.claimed", {
      identity,
    });
  }

  async recordToolResult(fingerprint, result, { identity = null } = {}) {
    const completedAt = new Date().toISOString();
    this.state.completedTools[fingerprint] = {
      completedAt,
      result,
    };

    if (identity) {
      const existing = this.getSideEffectTool(identity.operationKey);
      if (!existing || existing.fingerprint !== identity.fingerprint) {
        throw new Error(
          `Tool operation changed before completion: ${identity.operationKey}`,
        );
      }
      this.state.sideEffectTools[identity.operationKey] = {
        ...existing,
        status: "completed",
        completedAt,
        updatedAt: completedAt,
        result,
      };
    }

    this.state.pendingToolResult = result;
    await this.save();
    return await this.appendEvent("tool.completed", {
      fingerprint,
      result,
    });
  }

  async markSideEffectToolUnknown(identity, result) {
    const existing = this.getSideEffectTool(identity.operationKey);
    if (!existing || existing.fingerprint !== identity.fingerprint) {
      throw new Error(
        `Tool operation changed before unknown completion: ${identity.operationKey}`,
      );
    }

    const unknownAt = new Date().toISOString();
    this.state.sideEffectTools[identity.operationKey] = {
      ...existing,
      status: "unknown",
      unknownAt,
      updatedAt: unknownAt,
      result,
    };
    this.state.pendingToolResult = result;
    await this.save();
    return await this.appendEvent("tool.completion_unknown", {
      identity,
      result,
    });
  }

  async setPendingToolResult(result) {
    await this.update({ pendingToolResult: result });
  }

  async clearPendingToolResult() {
    if (this.state.pendingToolResult == null) {
      return;
    }
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
    this.state.followUps.push(item);
    this.state.lastError = null;
    await this.save();
    await this.appendEvent("session.instruction_added", item);
  }

  async recoverInterruptedSideEffects() {
    for (const [operationKey, entry] of Object.entries(this.state.sideEffectTools)) {
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
      this.state.sideEffectTools[operationKey] = {
        ...entry,
        status: "unknown",
        unknownAt: now,
        updatedAt: now,
        result,
      };
      this.state.pendingToolResult ??= result;
    }
    await this.save();
  }
}

// Compatibility export for callers using the pre-session class name.
export { AgentSession as TaskSession };
