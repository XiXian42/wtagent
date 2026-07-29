import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("package exposes only the wtagent executable", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );

  assert.equal(manifest.name, "wtagent");
  assert.equal(manifest.version, "0.1.0-alpha.0");
  assert.deepEqual(manifest.bin, {
    wtagent: "src/cli/main.js",
  });
});

test("CLI help and version use the WTAgent package identity", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const [{ stdout: help }, { stdout: version }] = await Promise.all([
    execFileAsync(process.execPath, [entry, "--help"]),
    execFileAsync(process.execPath, [entry, "--version"]),
  ]);

  assert.match(help, /^Usage: wtagent /);
  assert.match(help, /Turn your web AI session into a local tool-using agent/);
  assert.match(help, /\[task\.\.\.\]/);
  assert.match(help, /-C, --project <path>/);
  assert.doesNotMatch(help, /^\s+run(?:\s|$)/m);
  assert.equal(version.trim(), "0.1.0-alpha.0");
});

test("a task is accepted directly without a run subcommand", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const missingProject = path.join(
    repositoryRoot,
    "test",
    `missing-project-${process.pid}`,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      entry,
      "--once",
      "-C",
      missingProject,
      "build",
      "a",
      "site",
    ]),
    (error) => {
      assert.match(
        error.stderr,
        new RegExp(`Project directory does not exist: ${missingProject}`),
      );
      assert.doesNotMatch(error.stderr, /unknown command/i);
      return true;
    },
  );
});
