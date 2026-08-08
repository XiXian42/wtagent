import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  resolveLimits,
} from "../src/shared/limits.js";

test("model turn timeout defaults to ten minutes", () => {
  assert.equal(DEFAULT_LIMITS.modelTurnTimeoutMs, 10 * 60_000);
  assert.equal(resolveLimits().modelTurnTimeoutMs, 10 * 60_000);
});

test("tool transport limits use the bounded browser-safe defaults", () => {
  assert.equal(DEFAULT_LIMITS.maxFileReadBytes, 16 * 1024);
  assert.equal(DEFAULT_LIMITS.maxToolOutputBytes, 4 * 1024);
  assert.equal(DEFAULT_LIMITS.maxLocalToolLogBytes, 4 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxBrowserToolResultBytes, 24 * 1024);
});

test("model turn timeout accepts a positive integer CLI value", () => {
  const limits = resolveLimits({
    modelTurnTimeoutMs: "720000",
  });

  assert.equal(limits.modelTurnTimeoutMs, 720_000);
  assert.notEqual(limits, DEFAULT_LIMITS);
});

test("model turn timeout rejects invalid values", () => {
  for (const value of ["0", "-1", "1.5", "not-a-number"]) {
    assert.throws(
      () => resolveLimits({ modelTurnTimeoutMs: value }),
      /positive integer number of milliseconds/,
    );
  }
});
