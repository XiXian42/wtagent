#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import { ChatGPTWebAdapter } from "../browser/chatgpt-web-adapter.js";
import { launchNativeLoginBrowser } from "../browser/native-login.js";
import {
  ensureDirectory,
  getAppDataDir,
  getChromeProfileDir,
  getSessionsDir,
  getTasksDir,
} from "../platform/paths.js";
import { discoverChromeExecutable } from "../platform/chrome-discovery.js";
import {
  assertNativeRuntimeSupported,
  collectDoctorReport,
} from "../platform/windows-diagnostics.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { AgentSession } from "../session/agent-session.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { ProcessManager } from "../tools/process-manager.js";
import { resolveLimits } from "../shared/limits.js";
import { EXPORTERS } from "../session/session-export.js";
import { extractAtMentions } from "./at-files.js";
import {
  classifyChatInput,
  promptForText,
  readChatMessage,
  ShellChatInput,
} from "./prompt-input.js";
import { createRenderer } from "./render-events.js";

function resolveRuntimePaths(options) {
  const appDataDir = path.resolve(options.home ?? getAppDataDir());
  return {
    appDataDir,
    profileDir: path.resolve(
      options.profileDir ?? getChromeProfileDir(appDataDir),
    ),
    sessionsDir: getSessionsDir(appDataDir),
    legacyTasksDir: getTasksDir(appDataDir),
  };
}

async function assertDirectory(directory) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Project directory does not exist: ${directory}`);
  }
}

async function runLogin(options) {
  assertNativeRuntimeSupported();
  const { profileDir } = resolveRuntimePaths(options);
  for (;;) {
    console.log(`Opening native Chrome profile: ${profileDir}`);
    console.log(
      "This window has no CDP flags. Finish until ChatGPT shows your signed-in home/chat history and no Log in button.",
    );
    const browser = await launchNativeLoginBrowser({
      profileDir,
      chromePath: options.chromePath,
    });

    try {
      const answer = await promptForText({
        message:
          "After the signed-in ChatGPT home is visible, press Enter here to save and verify",
      });
      if (answer == null) {
        return;
      }
      console.log("Closing native Chrome and saving the dedicated profile...");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await browser.close();
    }

    const verifier = new ChatGPTWebAdapter({
      profileDir,
      chromePath: options.chromePath,
    });
    try {
      await verifier.launch();
      let authenticated = await verifier.getAuthState() === "authenticated";
      if (!authenticated) {
        try {
          await verifier.waitForManualLogin({ timeoutMs: 8_000 });
          authenticated = true;
        } catch {
          authenticated = false;
        }
      }
      if (authenticated) {
        console.log("ChatGPT login verified through a fresh CDP connection.");
        return;
      }
    } finally {
      await verifier.close();
    }

    console.log(
      "ChatGPT is still in guest mode. Reopening native Chrome; complete the final ChatGPT sign-in/continue step.",
    );
  }
}

// Resets local login by deleting the dedicated Chrome profile. Login state for
// this app lives entirely in that profile (chatgpt.com cookies + localStorage),
// so removing it returns wtagent to a clean guest state — useful for testing the
// full login → run flow. It never touches the real account server-side.
async function runLogout(options) {
  const { profileDir } = resolveRuntimePaths(options);
  const exists = await fs.stat(profileDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!exists) {
    console.log(`No Chrome profile found at ${profileDir}; already logged out.`);
    return;
  }

  // Guard: only ever delete something that is actually the dedicated profile.
  // A profile Chrome has used contains a "Default" profile directory; otherwise
  // require the conventional "chrome-profile" basename before removing.
  const looksLikeProfile = await fs.stat(path.join(profileDir, "Default"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!looksLikeProfile && path.basename(profileDir) !== "chrome-profile") {
    throw new Error(
      `Refusing to delete ${profileDir}: it does not look like a wtagent Chrome profile.`,
    );
  }

  if (!options.yes) {
    const confirmed = await confirm({
      message:
        `This deletes the local ChatGPT session (Chrome profile at ${profileDir}) `
        + "and requires a new login. Continue?",
      default: false,
    });
    if (!confirmed) {
      console.log("Logout cancelled.");
      return;
    }
  }

  await fs.rm(profileDir, { recursive: true, force: true });
  console.log(`Logged out. Removed ${profileDir}.`);
  console.log("Run `wtagent login` to sign in again.");
}

async function runDoctor(options) {
  const paths = resolveRuntimePaths(options);
  const report = await collectDoctorReport({
    paths,
    chromePath: options.chromePath,
  });

  for (const item of report.items) {
    const status = item.status.toUpperCase().padEnd(8);
    console.log(`${status} ${item.label}: ${item.detail}`);
  }
  console.log(`Data: ${paths.appDataDir}`);
  console.log(`Profile: ${paths.profileDir}`);
  console.log(report.exitCode === 0 ? "Doctor: OK" : "Doctor: FAILED");
  process.exitCode = report.exitCode;
}

// Owns the browser adapter, process manager, and renderer for the lifetime of
// one conversation. A single instance drives many turns: the first turn boots
// the session, and each later turn reuses the same open Chrome tab and session
// state via runtime.run({ resume: true }).
class ConversationRunner {
  constructor({ session, options }) {
    this.session = session;
    this.options = options;
    this.paths = resolveRuntimePaths(options);
    this.limits = resolveLimits({
      modelTurnTimeoutMs: options.modelTurnTimeoutMs,
    });
    this.processManager = new ProcessManager();
    this.renderer = createRenderer();
    this.adapter = new ChatGPTWebAdapter({
      profileDir: this.paths.profileDir,
      chromePath: options.chromePath,
      debug: options.debug,
      // Minimize by default; `--no-minimize` sets options.minimize === false.
      minimized: options.minimize !== false,
    });
    this.interrupted = false;
    this.closed = false;
  }

  #buildRuntime() {
    return new AgentRuntime({
      adapter: this.adapter,
      registry: createDefaultToolRegistry({
        processManager: this.processManager,
        limits: this.limits,
      }),
      policy: new PolicyEngine(),
      session: this.session,
      limits: this.limits,
      approval: async ({ toolCall, reasons }) => {
        this.renderer.stopSpinner();
        console.log(`\n${"\x1b[33m"}Approval required for ${toolCall.name}:${"\x1b[0m"}`);
        for (const reason of reasons) {
          console.log(`- ${reason}`);
        }
        console.log(JSON.stringify(toolCall.args, null, 2));
        return await confirm({
          message: "Allow this action once?",
          default: false,
        });
      },
      onEvent: (event) => this.renderer.handle(event),
    });
  }

  // Runs one turn. The first turn (resume=false) boots the session; later turns
  // resume the same conversation with a new user instruction. `files` are
  // resolved @file attachments for this turn's message.
  async runTurn({ resume, instruction, files = [] }) {
    const runtime = this.#buildRuntime();
    try {
      const result = await runtime.run({ resume, instruction, files });
      return result;
    } catch (error) {
      if (this.interrupted) {
        await this.session.update({
          phase: "interrupted",
          lastError: "Interrupted by user.",
        });
        await this.session.appendEvent("run.interrupted", {
          message: "Interrupted by user.",
        });
        return null;
      }
      if (this.session.state.phase !== "idle") {
        await this.session.update({
          phase: "interrupted",
          lastError: error.message,
        });
        await this.session.appendEvent("run.interrupted", {
          message: error.message,
        });
      }
      throw error;
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.renderer.finish();
    await this.processManager.stopAll().catch(() => {});
    await this.adapter.close().catch((error) => {
      console.error(`Warning: ${error.message}`);
    });
  }
}

async function executeSession({
  session,
  options,
  resume = false,
  instruction = null,
  files = [],
  chatInput = null,
}) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const runner = new ConversationRunner({ session, options });

  const onInterrupt = async () => {
    if (runner.interrupted) {
      return;
    }
    runner.interrupted = true;
    runner.renderer.stopSpinner();
    console.log("\nStopping managed processes and Chrome…");
    await runner.close();
    process.exitCode = 130;
  };
  process.on("SIGINT", onInterrupt);

  const interactive = !options.once && process.stdin.isTTY && process.stdout.isTTY;
  const activeChatInput = chatInput
    ?? (interactive ? new ShellChatInput() : null);
  if (instruction) {
    activeChatInput?.remember(instruction);
  }

  try {
    runner.renderer.hint(`Session ID: ${session.sessionId}`);
    let turnResume = resume;
    let turnInstruction = instruction;
    let turnFiles = files;

    for (;;) {
      const result = await runner.runTurn({
        resume: turnResume,
        instruction: turnInstruction,
        files: turnFiles,
      });
      if (runner.interrupted) {
        break;
      }
      if (!interactive) {
        return result;
      }

      // Managed dev servers keep running between turns; surface them once.
      const running = runner.processManager.list({ includeOutput: false }).filter(
        (item) => item.status === "running",
      );
      if (running.length > 0) {
        runner.renderer.hint("Managed processes still running:");
        for (const item of running) {
          runner.renderer.hint(
            `  ${item.processId} pid=${item.pid} ${item.detectedUrls.join(" ")}`,
          );
        }
      }

      const next = await promptForNextMessage(runner, activeChatInput);
      if (next == null) {
        break;
      }
      await session.appendInstruction(next.text, { files: next.files });
      turnResume = true;
      turnInstruction = next.text;
      turnFiles = next.files;
    }
    return null;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    activeChatInput?.close();
    await runner.close();
    console.log(`Session saved at: ${session.directory}`);
  }
}

// Reads the user's next message from the interactive prompt. Empty input simply
// re-prompts. Returns null for an explicit exit command, Ctrl+C, Ctrl+D, or EOF;
// otherwise returns
// { text, files } where files are resolved @file attachments.
async function promptForNextMessage(runner, chatInput) {
  for (;;) {
    const answer = chatInput
      ? await chatInput.read()
      : await promptForText({
        message: "you ›",
        theme: { prefix: "" },
      });
    if (answer == null) {
      // Ctrl+C / Ctrl+D inside the prompt ends the conversation cleanly.
      runner.renderer.println("");
      return null;
    }
    const classified = classifyChatInput(answer);
    if (classified.kind === "empty") {
      continue;
    }
    if (classified.kind === "exit") {
      return null;
    }
    const { text } = classified;
    const files = await resolveMessageAttachments(runner, text);
    return { text, files };
  }
}

// Parses @file mentions in a message, reports attached/missing files to the
// user, and returns the resolved attachment list.
async function resolveMessageAttachments(runner, text) {
  const projectRoot = runner.session.state.projectRoot;
  const { files, missing } = await extractAtMentions(text, projectRoot);
  if (files.length > 0) {
    runner.renderer.hint(
      `Attaching: ${files.map((file) => file.name).join(", ")}`,
    );
  }
  if (missing.length > 0) {
    runner.renderer.hint(
      `Not attached (${missing.map((m) => `${m.requested}: ${m.reason}`).join("; ")})`,
    );
  }
  return files;
}

async function runAgent(taskParts, options) {
  assertNativeRuntimeSupported();
  const projectRoot = path.resolve(options.project ?? process.cwd());
  await assertDirectory(projectRoot);
  const interactive = !options.once && process.stdin.isTTY && process.stdout.isTTY;
  const chatInput = interactive ? new ShellChatInput() : null;

  // In interactive mode an initial task is optional: the user can just start
  // typing at the prompt. In one-shot mode a task is required.
  let task = taskParts.join(" ").trim();
  if (!task) {
    if (interactive) {
      printChatBanner(projectRoot, options.mode);
    }
    const initialMessage = interactive
      ? await readChatMessage(() => chatInput.read())
      : await promptForText({
        message: "Task",
        validate: (value) => value.trim() ? true : "Please type a message.",
      });
    if (initialMessage == null) {
      chatInput?.close();
      console.log("");
      return null;
    }
    task = initialMessage.trim();
  } else if (interactive) {
    printChatBanner(projectRoot, options.mode);
    chatInput.remember(task);
  }

  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const session = await AgentSession.create({
    sessionsDir: paths.sessionsDir,
    task,
    projectRoot,
    mode: options.mode,
  });

  // Resolve @file attachments in the opening task, if any. The task itself is
  // already stored by AgentSession.create; here we only resolve the files to
  // attach on the first turn (run() records them on the opening user item).
  let files = [];
  if (task) {
    const { files: found, missing } = await extractAtMentions(task, projectRoot);
    files = found;
    if (found.length > 0) {
      console.log(`Attaching: ${found.map((file) => file.name).join(", ")}`);
    }
    if (missing.length > 0) {
      console.log(
        `Not attached (${missing.map((m) => `${m.requested}: ${m.reason}`).join("; ")})`,
      );
    }
  }

  return await executeSession({ session, options, files, chatInput });
}

function printChatBanner(projectRoot, mode) {
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";
  console.log("");
  console.log(`${CYAN}WTAgent${RESET} ${DIM}· GPT Web · ${projectRoot}${RESET}`);
  console.log(`${DIM}Enter sends · ↑/↓ history · "exit", Ctrl+C, or Ctrl+D quits${RESET}`);
  console.log("");
}

async function loadSession(paths, sessionId) {
  try {
    return await AgentSession.load({
      sessionsDir: paths.sessionsDir,
      sessionId,
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return await AgentSession.load({
      sessionsDir: paths.legacyTasksDir,
      sessionId,
    });
  }
}

async function runResume(sessionId, instructionParts, options) {
  assertNativeRuntimeSupported();
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const session = await loadSession(paths, sessionId);
  await assertDirectory(session.state.projectRoot);

  const instruction = instructionParts.join(" ").trim();
  let files = [];
  if (instruction) {
    const projectRoot = session.state.projectRoot;
    const { files: found, missing } = await extractAtMentions(instruction, projectRoot);
    files = found;
    if (found.length > 0) {
      console.log(`Attaching: ${found.map((file) => file.name).join(", ")}`);
    }
    if (missing.length > 0) {
      console.log(
        `Not attached (${missing.map((m) => `${m.requested}: ${m.reason}`).join("; ")})`,
      );
    }
    await session.appendInstruction(instruction, { files });
  }

  return await executeSession({
    session,
    options,
    resume: true,
    instruction: instruction || null,
    files,
  });
}

async function runStatus(sessionId, options) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  if (sessionId) {
    const session = await loadSession(paths, sessionId);
    console.log(JSON.stringify(session.state, null, 2));
    return;
  }

  const currentSessions = await AgentSession.list({
    sessionsDir: paths.sessionsDir,
  });
  const legacySessions = await AgentSession.list({
    sessionsDir: paths.legacyTasksDir,
  });
  const sessions = [...currentSessions, ...legacySessions]
    .filter((session, index, values) =>
      values.findIndex((candidate) =>
        candidate.sessionId === session.sessionId
      ) === index
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20);
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const session of sessions) {
    const summary = session.task.replaceAll(/\s+/g, " ").slice(0, 72);
    console.log(
      `${session.sessionId}\t${session.phase}\tturn=${session.turn}\t${summary}`,
    );
  }
}

async function runExport(sessionId, options) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const session = await loadSession(paths, sessionId);

  const format = options.format ?? "codex";
  const exporter = EXPORTERS[format];
  if (!exporter) {
    throw new Error(
      `Unknown export format "${format}". Use one of: ${Object.keys(EXPORTERS).join(", ")}.`,
    );
  }

  const transcript = await session.readTranscript();
  if (transcript.items.length === 0) {
    throw new Error(
      `Session ${sessionId} has no canonical transcript to export.`,
    );
  }

  const output = exporter(transcript, { sessionId: session.sessionId });
  if (options.output) {
    const target = path.resolve(options.output);
    await fs.writeFile(target, output, { mode: 0o600 });
    console.log(
      `Exported ${transcript.items.length} items to ${target} (${format}).`,
    );
  } else {
    process.stdout.write(output);
  }
}

const program = new Command()
  .name("wtagent")
  .description("Turn your web AI session into a local tool-using agent.")
  .version("0.1.0-alpha.3")
  .option("--home <path>", "Application data directory")
  .option("--profile-dir <path>", "Dedicated Chrome profile directory")
  .option("--chrome-path <path>", "Chrome/Chromium executable")
  .option("-C, --project <path>", "Project directory", process.cwd())
  .option("--mode <name>", "ChatGPT mode to select", "Pro")
  .option(
    "--once",
    "Run a single request and exit instead of a conversation",
    false,
  )
  .option(
    "--model-turn-timeout-ms <milliseconds>",
    "Maximum wait for one ChatGPT response (default: 600000)",
  )
  .option(
    "--no-minimize",
    "Keep the Chrome window visible instead of minimizing it",
  )
  .option("--debug", "Write browser diagnostics", false)
  .argument(
    "[task...]",
    "Initial request (optional; you can also type at the prompt)",
  )
  .action(async (task, _, command) => {
    await runAgent(task, command.optsWithGlobals());
  });

program
  .command("doctor")
  .description("Check Node, Chrome, and local data directories.")
  .action(async (_, command) => runDoctor(command.optsWithGlobals()));

program
  .command("login")
  .description("Open the dedicated Chrome profile and wait for ChatGPT login.")
  .action(async (_, command) => runLogin(command.optsWithGlobals()));

program
  .command("logout")
  .description("Delete the local Chrome profile to reset the ChatGPT session.")
  .option("--yes", "Skip the confirmation prompt", false)
  .action(async (options, command) => {
    await runLogout({ ...command.optsWithGlobals(), ...options });
  });

program
  .command("resume")
  .description("Continue an existing session or recover an interrupted run.")
  .argument("<session-id>", "Saved session ID")
  .argument("[instruction...]", "Optional follow-up instruction")
  .action(async (sessionId, instruction, _, command) => {
    await runResume(
      sessionId,
      instruction,
      command.optsWithGlobals(),
    );
  });

program
  .command("status")
  .description("List saved sessions or show one session as JSON.")
  .argument("[session-id]", "Saved session ID")
  .action(async (sessionId, _, command) => {
    await runStatus(sessionId, command.optsWithGlobals());
  });

program
  .command("export")
  .description("Export a saved session to a Codex or Claude Code session.")
  .argument("<session-id>", "Saved session ID")
  .option("--format <name>", "codex or claude-code", "codex")
  .option("-o, --output <path>", "Write to a file instead of stdout")
  .action(async (sessionId, options, command) => {
    await runExport(sessionId, { ...command.optsWithGlobals(), ...options });
  });

program.parseAsync().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
