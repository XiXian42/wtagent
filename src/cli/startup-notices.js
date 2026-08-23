import { fetchJson, NETWORK_TIMEOUT_MS } from "../shared/fetch-json.js";
import { getPackageVersion } from "../shared/package-info.js";
import { NoticeStore, getNoticeStorePath } from "./notice-store.js";
import {
  MANUAL_INSTALL_COMMAND,
  fetchLatestVersion,
  installLatest,
  isRemoteNewer,
} from "./self-update.js";

export const NOTICES_URL =
  "https://raw.githubusercontent.com/XiXian42/wtagent/main/notices.json";
export const NOTICE_TIMEOUT_MS = NETWORK_TIMEOUT_MS;
const MAX_NOTICE_TEXT = 2_000;
const MAX_NOTICE_ID = 128;

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export function sanitizeNoticeText(value) {
  return String(value ?? "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
    .slice(0, MAX_NOTICE_TEXT);
}

function normalizeTimes(value) {
  if (value == null) {
    return 1;
  }
  const times = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(times)) {
    return 1;
  }
  return Math.max(0, Math.floor(times));
}

export function parseNoticeDocument(document) {
  const raw = Array.isArray(document?.notices) ? document.notices : [];
  const notices = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const text = sanitizeNoticeText(entry.text);
    if (!id || id.length > MAX_NOTICE_ID || !text || seen.has(id)) {
      continue;
    }
    seen.add(id);
    notices.push({
      id,
      text,
      times: normalizeTimes(entry.times),
    });
  }
  return notices;
}

export function selectNotice(notices, store) {
  for (const notice of notices) {
    if (notice.times <= 0) {
      continue;
    }
    if (store.shownCount(notice.id) >= notice.times) {
      continue;
    }
    return notice;
  }
  return null;
}

export function formatNotice(text) {
  return `\n${CYAN}Notice${RESET}\n${text}\n`;
}

export async function fetchNoticeDocument({
  fetchImpl,
  timeoutMs = NOTICE_TIMEOUT_MS,
  url = NOTICES_URL,
} = {}) {
  const document = await fetchJson(url, { fetchImpl, timeoutMs });
  return document && typeof document === "object" ? document : null;
}

export async function runStartupChecks({
  appDataDir,
  interactive = true,
  fetchLatest = fetchLatestVersion,
  fetchNotices = fetchNoticeDocument,
  install = installLatest,
  promptUpdate,
  write = (text) => {
    console.log(text);
  },
  writeError = (text) => {
    console.error(text);
  },
  now,
} = {}) {
  if (!interactive) {
    return "continue";
  }

  const store = new NoticeStore({
    filePath: getNoticeStorePath(appDataDir),
    now,
  });
  await store.ensureLoaded();

  const needUpdateCheck = !store.wasUpdatePromptedToday();
  const needNotice = !store.wasNoticeShownToday();
  const latestPromise = needUpdateCheck
    ? fetchLatest({ timeoutMs: NOTICE_TIMEOUT_MS })
    : Promise.resolve(null);
  const noticesPromise = needNotice
    ? fetchNotices({ timeoutMs: NOTICE_TIMEOUT_MS })
    : Promise.resolve(null);

  const currentVersion = getPackageVersion();
  const latest = await latestPromise;
  if (needUpdateCheck && latest) {
    if (isRemoteNewer(latest, currentVersion)) {
      write(`A newer WTAgent is available: ${currentVersion} → ${latest}`);
      const choice = await promptUpdate({ currentVersion, latest });
      if (choice == null) {
        return "aborted";
      }
      await store.markUpdatePrompted();
      if (choice) {
        write(`Updating WTAgent ${currentVersion} → ${latest} ...`);
        const result = await install();
        if (result.ok) {
          write(`Updated to ${latest}. Restart wtagent to use the new version.`);
          return "updated";
        }
        writeError("Update failed.");
        writeError(`Install it manually: ${MANUAL_INSTALL_COMMAND}`);
      }
    } else {
      await store.markUpdatePrompted();
    }
  }

  if (!needNotice) {
    return "continue";
  }

  const notices = parseNoticeDocument(await noticesPromise);
  const selected = selectNotice(notices, store);
  if (!selected) {
    return "continue";
  }
  write(formatNotice(selected.text).trimEnd());
  await store.recordNoticeShown(selected.id);
  return "continue";
}
