import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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
  assert.equal(manifest.version, "0.1.0-alpha.6");
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
  assert.equal(version.trim(), "0.1.0-alpha.6");
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
      assert.ok(
        error.stderr.includes(
          `Project directory does not exist: ${missingProject}`,
        ),
      );
      assert.doesNotMatch(error.stderr, /unknown command/i);
      return true;
    },
  );
});

test("logout --yes removes the dedicated Chrome profile", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-logout-"));
  try {
    const profileDir = path.join(home, "chrome-profile");
    await fs.mkdir(path.join(profileDir, "Default"), { recursive: true });
    await fs.writeFile(path.join(profileDir, "Default", "Cookies"), "session");

    const { stdout } = await execFileAsync(process.execPath, [
      entry, "--home", home, "logout", "--yes",
    ]);
    assert.match(stdout, /Logged out\./);
    await assert.rejects(fs.stat(profileDir), { code: "ENOENT" });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("logout refuses to delete a directory that is not a wtagent profile", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const safe = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-safe-"));
  try {
    await fs.writeFile(path.join(safe, "important.txt"), "keep me");

    await assert.rejects(
      execFileAsync(process.execPath, [
        entry, "--profile-dir", safe, "logout", "--yes",
      ]),
      (error) => {
        assert.match(error.stderr, /does not look like a wtagent Chrome profile/);
        return true;
      },
    );
    // The guard left the directory untouched.
    assert.equal(await fs.readFile(path.join(safe, "important.txt"), "utf8"), "keep me");
  } finally {
    await fs.rm(safe, { recursive: true, force: true });
  }
});
