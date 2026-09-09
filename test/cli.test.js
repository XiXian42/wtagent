import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { executeSession, promptToResolveProfileLock } from "../src/cli/main.js";
import { AgentSession } from "../src/session/agent-session.js";

async function sessionHarness(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-cli-session-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const session = await AgentSession.create({ sessionsDir: path.join(home, "sessions"), projectRoot: home, task: "original" });
  return { home, session };
}

for (const followUp of [false, true]) {
  test(`ESC waits for a new instruction after cancelling ${followUp ? "a follow-up" : "the opening turn"}`, async (t) => {
    const { home, session } = await sessionHarness(t);
    const trace = [];
    const calls = [];
    const freshFiles = [{ name: "fresh.txt", path: path.join(home, "fresh.txt") }];
    let prompts = 0;
    let closed = false;
    const runner = {
      renderer: { hint() {} },
      processManager: { list: () => [] },
      async runTurn(args) {
        trace.push("run");
        calls.push(args);
        return calls.length === 1 ? { cancelled: true } : { message: "done" };
      },
      async close() { closed = true; },
    };
    await executeSession({
      session, options: { home }, resume: followUp,
      instruction: followUp ? "cancelled instruction" : null,
      files: [{ name: "old.txt", path: path.join(home, "old.txt") }],
      chatInput: { remember() {}, close() {} },
    }, {
      interactive: true,
      createRunner: () => runner,
      readNextMessage: async () => {
        trace.push("prompt");
        return prompts++ === 0 ? { text: "new instruction", files: freshFiles } : null;
      },
    });
    assert.deepEqual(trace, ["run", "prompt", "run", "prompt"]);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].instruction, "new instruction");
    assert.deepEqual(calls[1].files, freshFiles);
    assert.equal(calls[1].inPlaceRecovery, false);
    assert.equal(session.state.followUps.at(-1).instruction, "new instruction");
    assert.equal(closed, true);
  });
}

test("quitting the prompt after ESC does not run another turn", async (t) => {
  const { home, session } = await sessionHarness(t);
  let runs = 0;
  let closed = false;
  await executeSession({ session, options: { home }, chatInput: { close() {} } }, {
    interactive: true,
    createRunner: () => ({
      renderer: { hint() {} }, processManager: { list: () => [] },
      async runTurn() { runs += 1; return { cancelled: true }; },
      async close() { closed = true; },
    }),
    readNextMessage: async () => null,
  });
  assert.equal(runs, 1);
  assert.equal(closed, true);
});

test("interactive pending recovery ignores instructions until bare retry", async (t) => {
  const { home, session } = await sessionHarness(t);
  const outboundId = "11111111-1111-4111-8111-111111111111";
  const calls = [];
  const promptOptions = [];
  let prompts = 0;
  const runner = {
    renderer: { hint() {}, providerLabel: "ChatGPT" },
    processManager: { list: () => [] },
    async runTurn(args) {
      calls.push(args);
      if (calls.length === 1) {
        await session.update({
          pendingAssistantTurn: {
            version: 1,
            handoffId: `outbound:${outboundId}`,
            sourceOutboundId: outboundId,
            outboundKind: "bootstrap",
            runtimeTurn: 1,
            status: "waiting",
            conversationTargetId: "target-pending",
          },
        });
        return { recoveryRequired: true, error: new Error("retry") };
      }
      await session.update({ pendingAssistantTurn: null });
      return { message: "recovered" };
    },
    async close() {},
  };

  await executeSession({
    session,
    options: { home },
    chatInput: { close() {} },
  }, {
    interactive: true,
    createRunner: () => runner,
    readNextMessage: async (_runner, _input, options) => {
      promptOptions.push(options);
      prompts += 1;
      if (prompts === 1) {
        return {
          text: "inspect @secret.txt",
          files: [{ name: "secret.txt", path: path.join(home, "secret.txt") }],
        };
      }
      if (prompts === 2) {
        return { text: "/retry", files: [] };
      }
      return null;
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, true);
  assert.equal(calls[1].instruction, null);
  assert.deepEqual(calls[1].files, []);
  assert.equal(calls[1].inPlaceRecovery, true);
  assert.equal(promptOptions[0].resolveAttachments, false);
  assert.equal(promptOptions[1].resolveAttachments, false);
  assert.deepEqual(session.state.followUps, []);
});

test("internal SIGINT reaches CLI cleanup without a second turn", async (t) => {
  const { home, session } = await sessionHarness(t);
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  let closed = false;
  const runner = {
    adapter: {}, renderer: { hint() {}, stopSpinner() {} },
    async runTurn() { process.emit("SIGINT", "SIGINT"); return { cancelled: true }; },
    async close() { closed = true; },
  };
  await executeSession({ session, options: { home }, chatInput: { close() {} } }, {
    interactive: true,
    createRunner: () => runner,
    readNextMessage: async () => { throw new Error("interruption must exit"); },
  });
  assert.equal(runner.interrupted, true);
  assert.equal(runner.adapter.escCancelRequested, true);
  assert.equal(process.exitCode, 130);
  assert.equal(closed, true);
});

test("profile lock recovery refuses to terminate the current process", async (t) => {
  const kill = t.mock.method(process, "kill", () => { throw new Error("must not terminate"); });
  await assert.rejects(promptToResolveProfileLock({ details: { pid: process.pid } }), /Refusing to terminate itself/);
  assert.equal(kill.mock.callCount(), 0);
});

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("package exposes only the wtagent executable", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const lockfile = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
  );

  assert.equal(manifest.name, "wtagent");
  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages[""].version, manifest.version);
  assert.deepEqual(manifest.bin, {
    wtagent: "src/cli/main.js",
  });
});

for (const stateField of ["pendingOutbound", "pendingAssistantTurn"]) {
  test(`resume rejects instruction text before mutating ${stateField}`, async (t) => {
    const { home, session } = await sessionHarness(t);
    const outboundId = "11111111-1111-4111-8111-111111111111";
    await fs.writeFile(path.join(home, "secret.txt"), "not attached", "utf8");
    await session.update({
      [stateField]: stateField === "pendingOutbound"
        ? {
          outboundId,
          kind: "bootstrap",
          transcriptItems: [],
          status: "commit-unknown",
        }
        : {
          version: 1,
          handoffId: `outbound:${outboundId}`,
          sourceOutboundId: outboundId,
          outboundKind: "bootstrap",
          status: "waiting",
          conversationTargetId: "target-pending",
        },
    });
    const entry = path.join(repositoryRoot, "src", "cli", "main.js");

    await assert.rejects(
      execFileAsync(process.execPath, [
        entry,
        "--home",
        home,
        "--once",
        "resume",
        session.sessionId,
        "inspect",
        "@secret.txt",
      ]),
      (error) => {
        assert.match(error.stderr, /pending browser handoff/i);
        assert.doesNotMatch(error.stdout, /secret\.txt|attach/i);
        return true;
      },
    );

    const reloaded = await AgentSession.load({
      sessionsDir: path.join(home, "sessions"),
      sessionId: session.sessionId,
    });
    assert.deepEqual(reloaded.state.followUps, []);
  });
}

test("CLI help and version use the WTAgent package identity", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const manifest = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const [{ stdout: help }, { stdout: version }] = await Promise.all([
    execFileAsync(process.execPath, [entry, "--help"]),
    execFileAsync(process.execPath, [entry, "--version"]),
  ]);

  assert.match(help, /^Usage: wtagent /);
  assert.match(help, /Turn your web AI session into a local tool-using agent/);
  assert.match(help, /\[task\.\.\.\]/);
  assert.match(help, /-C, --project <path>/);
  assert.match(help, /^\s+update\s+/m);
  assert.doesNotMatch(help, /^\s+run(?:\s|$)/m);
  assert.equal(version.trim(), manifest.version);
});

test("update command is documented and does not require a project", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const { stdout } = await execFileAsync(process.execPath, [
    entry,
    "update",
    "--help",
  ]);

  assert.match(stdout, /^Usage: wtagent update/);
  assert.match(stdout, /Install the latest WTAgent from npm/);
});

test("help documents the --model provider option", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const { stdout } = await execFileAsync(process.execPath, [entry, "--help"]);

  assert.match(stdout, /--model <provider>/);
  assert.match(stdout, /chatgpt.*deepseek/);
  assert.match(stdout, /claude/);
  assert.match(stdout, /gemini/);
});

test("an unknown --model is rejected with the known provider list", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const missingSafe = path.join(repositoryRoot, "test");

  await assert.rejects(
    execFileAsync(process.execPath, [
      entry, "--once", "--model", "bogus", "-C", missingSafe, "hi",
    ]),
    (error) => {
      assert.match(error.stderr, /Unknown model "bogus"/);
      assert.match(error.stderr, /chatgpt, deepseek/);
      return true;
    },
  );
});

test("--mode is no longer exposed or accepted", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const { stdout: help } = await execFileAsync(process.execPath, [entry, "--help"]);
  assert.doesNotMatch(help, /--mode\b/);

  await assert.rejects(
    execFileAsync(process.execPath, [entry, "--once", "--mode", "kimi", "hi"]),
    (error) => {
      assert.match(error.stderr, /unknown option '--mode'/i);
      return true;
    },
  );
});

test("--model grok is recognized as an active provider", async () => {
  const entry = path.join(repositoryRoot, "src", "cli", "main.js");
  const missingProject = path.join(
    repositoryRoot,
    "test",
    `missing-grok-${process.pid}`,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      entry, "--once", "--model", "grok", "-C", missingProject, "hi",
    ]),
    (error) => {
      assert.doesNotMatch(error.stderr, /not supported yet/);
      assert.ok(
        error.stderr.includes(
          `Project directory does not exist: ${missingProject}`,
        ),
      );
      return true;
    },
  );
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
