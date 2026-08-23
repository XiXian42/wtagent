import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NoticeStore, getNoticeStorePath, localDateString } from "../src/cli/notice-store.js";
import {
  parseNoticeDocument,
  runStartupChecks,
  sanitizeNoticeText,
  selectNotice,
} from "../src/cli/startup-notices.js";
import { getPackageVersion } from "../src/shared/package-info.js";

function dateAt(isoDate) {
  return new Date(`${isoDate}T12:00:00`);
}

async function withStore(t, isoDate) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    store: new NoticeStore({
      filePath: getNoticeStorePath(dir),
      now: () => dateAt(isoDate),
    }),
  };
}

test("notice documents keep valid entries and drop junk", () => {
  const notices = parseNoticeDocument({
    notices: [
      { id: "web-support", text: "New web provider support is available.", times: 3 },
      { id: "  ", text: "missing id" },
      { id: "empty", text: "   " },
      { id: "web-support", text: "duplicate id is ignored" },
      { id: "once", text: "Shown once by default." },
      null,
      "nope",
    ],
  });
  assert.deepEqual(notices, [
    { id: "web-support", text: "New web provider support is available.", times: 3 },
    { id: "once", text: "Shown once by default.", times: 1 },
  ]);
});

test("notice text is stripped of control sequences", () => {
  assert.equal(
    sanitizeNoticeText("Hello\u001b[31mRed\u001b[0m\nWorld\u0007"),
    "HelloRed\nWorld",
  );
});

test("a notice is selected in document order until its times are used up", async (t) => {
  const { store } = await withStore(t, "2026-08-14");
  await store.ensureLoaded();
  const notices = [
    { id: "first", text: "one", times: 1 },
    { id: "second", text: "two", times: 2 },
  ];
  assert.equal(selectNotice(notices, store).id, "first");
  await store.recordNoticeShown("first");
  assert.equal(selectNotice(notices, store).id, "second");
  await store.recordNoticeShown("second");
  assert.equal(selectNotice(notices, store).id, "second");
  await store.recordNoticeShown("second");
  assert.equal(selectNotice(notices, store), null);
});

test("notice impressions persist across reloads", async (t) => {
  const { dir } = await withStore(t, "2026-08-14");
  const filePath = getNoticeStorePath(dir);
  const store = new NoticeStore({
    filePath,
    now: () => dateAt("2026-08-14"),
  });
  await store.ensureLoaded();
  await store.recordNoticeShown("web-support");

  const reloaded = new NoticeStore({
    filePath,
    now: () => dateAt("2026-08-14"),
  });
  await reloaded.ensureLoaded();
  assert.equal(reloaded.shownCount("web-support"), 1);
  assert.equal(reloaded.wasNoticeShownToday(), true);
  assert.equal(reloaded.wasUpdatePromptedToday(), false);
});

test("a notice with times=3 appears on the first three opening days", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const days = [
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
    "2026-08-13",
    "2026-08-14",
  ];
  const shown = [];
  for (const day of days) {
    const result = await runStartupChecks({
      appDataDir: dir,
      now: () => dateAt(day),
      fetchLatest: async () => getPackageVersion(),
      fetchNotices: async () => ({
        notices: [{ id: "web-support", text: "New web support.", times: 3 }],
      }),
      promptUpdate: async () => {
        throw new Error("should not prompt");
      },
      write: (line) => {
        if (String(line).includes("New web support.")) {
          shown.push(day);
        }
      },
    });
    assert.equal(result, "continue");
  }
  assert.deepEqual(shown, ["2026-08-10", "2026-08-11", "2026-08-12"]);
});

test("the same notice is not shown twice on one day", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let fetches = 0;
  const run = () => runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => getPackageVersion(),
    fetchNotices: async () => {
      fetches += 1;
      return { notices: [{ id: "once", text: "Hello once." }] };
    },
    write: () => {},
  });
  assert.equal(await run(), "continue");
  assert.equal(await run(), "continue");
  assert.equal(fetches, 1);
});

test("startup update prompts at most once a day and can install immediately", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompts = [];
  let installs = 0;

  const first = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => "9.9.9",
    fetchNotices: async () => ({ notices: [] }),
    promptUpdate: async ({ currentVersion, latest }) => {
      prompts.push(`${currentVersion}->${latest}`);
      return true;
    },
    install: async () => {
      installs += 1;
      return { ok: true };
    },
    write: () => {},
  });
  assert.equal(first, "updated");
  assert.equal(installs, 1);

  const second = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => {
      throw new Error("should not check again today");
    },
    fetchNotices: async () => ({ notices: [] }),
    promptUpdate: async () => {
      throw new Error("should not prompt again today");
    },
    write: () => {},
  });
  assert.equal(second, "continue");
  assert.deepEqual(prompts, [`${getPackageVersion()}->9.9.9`]);
});

test("declining an update still consumes the daily prompt", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let prompts = 0;
  const first = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => "9.9.9",
    fetchNotices: async () => ({
      notices: [{ id: "hello", text: "Shown after the update prompt." }],
    }),
    promptUpdate: async () => {
      prompts += 1;
      return false;
    },
    install: async () => {
      throw new Error("should not install");
    },
    write: () => {},
  });
  assert.equal(first, "continue");
  assert.equal(prompts, 1);

  const store = new NoticeStore({
    filePath: getNoticeStorePath(dir),
    now: () => dateAt("2026-08-14"),
  });
  await store.ensureLoaded();
  assert.equal(store.wasUpdatePromptedToday(), true);
  assert.equal(store.shownCount("hello"), 1);
});

test("an already-current version is not checked again the same day", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let checks = 0;
  const run = () => runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => {
      checks += 1;
      return getPackageVersion();
    },
    fetchNotices: async () => ({ notices: [] }),
    promptUpdate: async () => {
      throw new Error("should not prompt");
    },
    write: () => {},
  });
  assert.equal(await run(), "continue");
  assert.equal(await run(), "continue");
  assert.equal(checks, 1);
});

test("network failures are skipped without blocking startup", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => null,
    fetchNotices: async () => null,
    promptUpdate: async () => {
      throw new Error("should not prompt");
    },
    write: () => {},
  });
  assert.equal(result, "continue");
});

test("non-interactive sessions skip startup checks", async () => {
  const result = await runStartupChecks({
    interactive: false,
    fetchLatest: async () => {
      throw new Error("should not fetch");
    },
    fetchNotices: async () => {
      throw new Error("should not fetch");
    },
  });
  assert.equal(result, "continue");
});

test("cancelling the update prompt aborts startup without recording it", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => "9.9.9",
    fetchNotices: async () => ({ notices: [] }),
    promptUpdate: async () => null,
    write: () => {},
  });
  assert.equal(result, "aborted");
  const store = new NoticeStore({
    filePath: getNoticeStorePath(dir),
    now: () => dateAt("2026-08-14"),
  });
  await store.ensureLoaded();
  assert.equal(store.wasUpdatePromptedToday(), false);
});

test("localDateString uses the local calendar day", () => {
  assert.equal(localDateString(new Date(2026, 7, 14, 23, 59, 59)), "2026-08-14");
  assert.equal(localDateString(new Date(2026, 7, 15, 0, 0, 1)), "2026-08-15");
});

test("a corrupt notices file is ignored instead of crashing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(getNoticeStorePath(dir), "not-json{{", "utf8");

  const result = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => getPackageVersion(),
    fetchNotices: async () => ({
      notices: [{ id: "hello", text: "Recovered after a corrupt store." }],
    }),
    write: () => {},
  });
  assert.equal(result, "continue");

  const store = new NoticeStore({
    filePath: getNoticeStorePath(dir),
    now: () => dateAt("2026-08-14"),
  });
  await store.ensureLoaded();
  assert.equal(store.shownCount("hello"), 1);
});

test("a successful update exits before showing a notice", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lines = [];
  const result = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => "9.9.9",
    fetchNotices: async () => ({
      notices: [{ id: "hello", text: "Should not appear after an update." }],
    }),
    promptUpdate: async () => true,
    install: async () => ({ ok: true }),
    write: (line) => lines.push(String(line)),
  });
  assert.equal(result, "updated");
  assert.equal(lines.some((line) => line.includes("Should not appear")), false);
});

test("a failed update still shows the notice", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-notices-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lines = [];
  const errors = [];
  const result = await runStartupChecks({
    appDataDir: dir,
    now: () => dateAt("2026-08-14"),
    fetchLatest: async () => "9.9.9",
    fetchNotices: async () => ({
      notices: [{ id: "hello", text: "Shown after a failed update." }],
    }),
    promptUpdate: async () => true,
    install: async () => ({ ok: false }),
    write: (line) => lines.push(String(line)),
    writeError: (line) => errors.push(String(line)),
  });
  assert.equal(result, "continue");
  assert.equal(lines.some((line) => line.includes("Shown after a failed update.")), true);
  assert.equal(errors.some((line) => line.includes("Update failed.")), true);
});
