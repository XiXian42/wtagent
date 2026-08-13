import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fallbackSearch } from "../src/tools/search-fallback.js";

async function fixtureTree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-search-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of [
    ["src/a.js", "const needle = 1;"],
    ["vendor/b.js", "const needle = 2;"],
    ["generated/c.js", "const needle = 3;"],
    ["lib.min.js", "const needle = 4;"],
  ]) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

test("fallback search excludes directories by basename pattern", async (t) => {
  const root = await fixtureTree(t);
  const output = await fallbackSearch({
    query: "needle",
    searchPath: root,
    excludePatterns: ["vendor"],
  });
  assert.match(output, /src[\\/]a\.js/);
  assert.doesNotMatch(output, /vendor/);
});

test("fallback search prunes subtrees matched by a trailing /** pattern", async (t) => {
  const root = await fixtureTree(t);
  const output = await fallbackSearch({
    query: "needle",
    searchPath: root,
    excludePatterns: ["generated/**"],
  });
  assert.match(output, /src[\\/]a\.js/);
  assert.doesNotMatch(output, /generated/);
});

test("fallback search excludes files by basename glob", async (t) => {
  const root = await fixtureTree(t);
  const output = await fallbackSearch({
    query: "needle",
    searchPath: root,
    excludePatterns: ["*.min.js"],
  });
  assert.match(output, /src[\\/]a\.js/);
  assert.doesNotMatch(output, /lib\.min\.js/);
});

test("fallback search excludes files matched by a path glob", async (t) => {
  const root = await fixtureTree(t);
  const output = await fallbackSearch({
    query: "needle",
    searchPath: root,
    excludePatterns: ["**/b.js"],
  });
  assert.match(output, /src[\\/]a\.js/);
  assert.doesNotMatch(output, /b\.js/);
});

test("fallback search ignores empty exclude patterns", async (t) => {
  const root = await fixtureTree(t);
  const output = await fallbackSearch({
    query: "needle",
    searchPath: root,
    excludePatterns: ["", "  "],
  });
  assert.match(output, /src[\\/]a\.js/);
  assert.match(output, /vendor/);
  assert.match(output, /generated/);
});
