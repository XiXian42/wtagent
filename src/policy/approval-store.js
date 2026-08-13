import fs from "node:fs/promises";
import { replaceFileAtomic } from "../shared/atomic-write.js";

// Persisted "always allow" decisions made at the approval prompt. Lives in the
// app data directory so it survives session resumes and new sessions.
export class ApprovalStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.toolNames = new Set();
    this.allowAll = false;
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed?.allowAll === true) {
        this.allowAll = true;
      }
      for (const name of parsed?.toolNames ?? []) {
        if (typeof name === "string" && name) {
          this.toolNames.add(name);
        }
      }
    } catch (error) {
      // A missing or unreadable file simply means no saved approvals. Anything
      // beyond ENOENT is treated as corrupt and ignored rather than crashing.
      if (error.code !== "ENOENT") {
        this.toolNames.clear();
        this.allowAll = false;
      }
    }
  }

  isAlwaysAllowed(toolName) {
    return this.allowAll || this.toolNames.has(toolName);
  }

  setAlwaysAllowedTool(toolName) {
    this.toolNames.add(toolName);
  }

  setAlwaysAllowAll() {
    this.allowAll = true;
  }

  async save() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify({
        toolNames: [...this.toolNames].sort(),
        allowAll: this.allowAll,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    try {
      await replaceFileAtomic(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
