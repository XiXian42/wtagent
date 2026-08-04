import test from "node:test";
import assert from "node:assert/strict";
import { replaceFileAtomic } from "../src/shared/atomic-write.js";

test("Windows atomic replacement retries transient sharing violations", async () => {
  let calls = 0;
  await replaceFileAtomic("next.tmp", "state.json", {
    platform: "win32",
    retryDelayMs: 0,
    rename: async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      }
    },
  });
  assert.equal(calls, 3);
});

test("persistent Windows replacement failure leaves deletion to no fallback", async () => {
  let calls = 0;
  await assert.rejects(
    replaceFileAtomic("next.tmp", "state.json", {
      platform: "win32",
      attempts: 3,
      retryDelayMs: 0,
      rename: async () => {
        calls += 1;
        throw Object.assign(new Error("still locked"), { code: "EACCES" });
      },
    }),
    /still locked/,
  );
  assert.equal(calls, 3);
});

test("non-Windows replacement failures do not retry", async () => {
  let calls = 0;
  await assert.rejects(
    replaceFileAtomic("next.tmp", "state.json", {
      platform: "darwin",
      rename: async () => {
        calls += 1;
        throw Object.assign(new Error("rename failed"), { code: "EPERM" });
      },
    }),
    /rename failed/,
  );
  assert.equal(calls, 1);
});
