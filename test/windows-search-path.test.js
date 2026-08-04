import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertWindowsSafeName,
  isPathInside,
  resolveToolPath,
} from "../src/policy/path-guard.js";
import { fallbackSearch } from "../src/tools/search-fallback.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-win-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function createDirectorySymlink(t, target, linkPath) {
  try {
    await fs.symlink(
      target,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      process.platform === "win32"
      && (error.code === "EPERM" || error.code === "EACCES")
    ) {
      t.skip("Creating directory symlinks requires additional privileges.");
      return false;
    }
    throw error;
  }
  return true;
}

test("javascript search supports fixed strings, regex, globs, limits, and skips excluded content", async (t) => {
  const root = await makeFixture(t);
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "coverage"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.js"), "alpha\nbeta target\n", "utf8");
  await fs.writeFile(path.join(root, "root.js"), "root target\n", "utf8");
  await fs.writeFile(path.join(root, "src", "nested", "b.txt"), "target\nTarget 123\n", "utf8");
  await fs.writeFile(path.join(root, "coverage", "ignored.txt"), "target", "utf8");
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));

  const fixed = await fallbackSearch({
    query: "target",
    searchPath: root,
    maxResults: 10,
  });
  const fixedLines = fixed.split("\n").filter(Boolean);
  assert.equal(fixedLines.length, 3);
  assert.match(fixedLines[0], /root\.js:1:root target$/);
  assert.match(fixedLines[1], /src[\/\\]a\.js:2:beta target$/);
  assert.match(fixedLines[2], /src[\/\\]nested[\/\\]b\.txt:1:target$/);
  assert.doesNotMatch(fixed, /coverage|large\.txt|binary\.bin/);

  const regex = await fallbackSearch({
    query: "^Target\\s+\\d+$",
    searchPath: root,
    regex: true,
    maxResults: 10,
  });
  assert.match(regex, /b\.txt:2:Target 123$/);

  const glob = await fallbackSearch({
    query: "target",
    searchPath: root,
    glob: "**/*.js",
    maxResults: 10,
  });
  assert.match(glob, /a\.js:2:beta target$/m);
  assert.match(glob, /root\.js:1:root target$/m);
  assert.doesNotMatch(glob, /b\.txt/);

  const basenameGlob = await fallbackSearch({
    query: "target",
    searchPath: root,
    glob: "*.js",
    maxResults: 10,
  });
  assert.match(basenameGlob, /root\.js:1:root target$/m);
  assert.match(basenameGlob, /src[\/\\]a\.js:2:beta target$/m);

  const limited = await fallbackSearch({
    query: "target",
    searchPath: root,
    maxResults: 1,
  });
  assert.equal(limited.split("\n").filter(Boolean).length, 1);
});

test("javascript search skips symlinked directories that escape the root", async (t) => {
  const root = await makeFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-win-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const linkPath = path.join(root, "linked");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "inside.txt"), "target", "utf8");
  await fs.writeFile(path.join(outside, "outside.txt"), "target", "utf8");
  const linked = await createDirectorySymlink(t, outside, linkPath);
  if (!linked) {
    return;
  }

  const result = await fallbackSearch({
    query: "target",
    searchPath: root,
    maxResults: 10,
  });
  assert.match(result, /inside\.txt:1:target$/);
  assert.doesNotMatch(result, /outside\.txt/);
});

test("path guard validates every Windows component and containment comparisons are case-insensitive", async (t) => {
  const root = await makeFixture(t);
  await fs.mkdir(path.join(root, "safe"));

  assert.throws(
    () => assertWindowsSafeName(String.raw`C:\safe\CON.txt`, { platform: "win32" }),
    /reserved Windows device name/i,
  );
  assert.throws(
    () => assertWindowsSafeName(String.raw`safe\bad. \file.txt`, { platform: "win32" }),
    /space or period/i,
  );

  const resolved = await resolveToolPath(root, path.join("safe", "nested", "file.txt"));
  assert.equal(resolved.inside, true);

  await assert.rejects(
    resolveToolPath(root, path.join("safe", "PRN", "file.txt"), { platform: "win32" }),
    /reserved Windows device name/i,
  );

  assert.equal(
    isPathInside(String.raw`C:\Workspace\Repo`, String.raw`c:\workspace\repo\src\index.js`, { platform: "win32" }),
    true,
  );
  assert.equal(
    isPathInside(String.raw`C:\Workspace\Repo`, String.raw`c:\workspace\repo-other\index.js`, { platform: "win32" }),
    false,
  );
});

test("resolveToolPath rejects symlink escapes via real paths", async (t) => {
  const root = await makeFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-path-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const linkPath = path.join(root, "escape");
  const linked = await createDirectorySymlink(t, outside, linkPath);
  if (!linked) {
    return;
  }

  const result = await resolveToolPath(root, path.join("escape", "file.txt"));
  assert.equal(result.inside, false);
});

test("terminal description stays platform-neutral about external filters", () => {
  const terminal = createDefaultToolRegistry().list()
    .find((tool) => tool.name === "terminal.exec");
  assert.doesNotMatch(terminal.description, /grep -m|head -n|tail -n|git status|git diff|rg --max-count/);
  assert.match(terminal.description, /fs\.search\/fs\.read/);
  assert.match(terminal.description, /test-runner filters/);
});

test("path guard handles UNC server-share paths on win32", () => {
  assert.equal(
    isPathInside(
      String.raw`\\server\share\repo`,
      String.raw`\\server\share\repo\src\index.js`,
      { platform: "win32" },
    ),
    true,
  );
  assert.equal(
    isPathInside(
      String.raw`\\server\share\repo`,
      String.raw`\\server\share\other\index.js`,
      { platform: "win32" },
    ),
    false,
  );
});

test("path guard rejects all Windows reserved device names", () => {
  const reserved = [
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ];
  for (const name of reserved) {
    assert.throws(
      () => assertWindowsSafeName(`safe\\${name}.txt`, { platform: "win32" }),
      /reserved Windows device name/i,
      `${name} should be rejected`,
    );
    // Reserved names are case-insensitive.
    assert.throws(
      () => assertWindowsSafeName(`safe\\${name.toLowerCase()}.txt`, { platform: "win32" }),
      /reserved Windows device name/i,
      `${name.toLowerCase()} should be rejected`,
    );
    // Reserved names work with any extension.
    assert.throws(
      () => assertWindowsSafeName(`safe\\${name}.log`, { platform: "win32" }),
      /reserved Windows device name/i,
      `${name}.log should be rejected`,
    );
  }
});

test("path guard rejects Windows illegal characters in path components", () => {
  const illegal = ["<", ">", ":", '"', "|", "?", "*"];
  for (const char of illegal) {
    assert.throws(
      () => assertWindowsSafeName(`safe\\file${char}name.txt`, { platform: "win32" }),
      /illegal on Windows/i,
      `character ${JSON.stringify(char)} should be rejected`,
    );
  }
});
