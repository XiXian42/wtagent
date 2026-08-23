import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "../shared/atomic-write.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localDateString(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDateString(value) {
  return typeof value === "string" && DATE_RE.test(value);
}

function normalizeItems(items) {
  const normalized = {};
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return normalized;
  }
  for (const [id, item] of Object.entries(items)) {
    if (!id || !item || typeof item !== "object") {
      continue;
    }
    const shown = Number.isFinite(item.shown) ? Math.max(0, Math.floor(item.shown)) : 0;
    normalized[id] = {
      shown,
      lastShownDate: isDateString(item.lastShownDate) ? item.lastShownDate : null,
    };
  }
  return normalized;
}

function normalizeData(parsed) {
  return {
    update: {
      lastPromptDate: isDateString(parsed?.update?.lastPromptDate)
        ? parsed.update.lastPromptDate
        : null,
    },
    notices: {
      lastShownDate: isDateString(parsed?.notices?.lastShownDate)
        ? parsed.notices.lastShownDate
        : null,
      items: normalizeItems(parsed?.notices?.items),
    },
  };
}

export function getNoticeStorePath(appDataDir) {
  return path.join(appDataDir, "notices.json");
}

// Persists the once-a-day update prompt and per-id notice impressions.
export class NoticeStore {
  constructor({ filePath, now = () => new Date() }) {
    this.filePath = filePath;
    this.now = now;
    this.data = normalizeData(null);
    this.loaded = false;
  }

  today() {
    return localDateString(this.now());
  }

  async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      this.data = normalizeData(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.data = normalizeData(null);
      }
    }
  }

  wasUpdatePromptedToday() {
    return this.data.update.lastPromptDate === this.today();
  }

  wasNoticeShownToday() {
    return this.data.notices.lastShownDate === this.today();
  }

  shownCount(id) {
    return this.data.notices.items[id]?.shown ?? 0;
  }

  async markUpdatePrompted() {
    this.data.update.lastPromptDate = this.today();
    await this.save();
  }

  async recordNoticeShown(id) {
    const today = this.today();
    const previous = this.data.notices.items[id] ?? { shown: 0, lastShownDate: null };
    this.data.notices.lastShownDate = today;
    this.data.notices.items[id] = {
      shown: previous.shown + 1,
      lastShownDate: today,
    };
    await this.save();
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(this.data, null, 2)}\n`,
      { mode: 0o600 },
    );
    try {
      await replaceFileAtomic(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
