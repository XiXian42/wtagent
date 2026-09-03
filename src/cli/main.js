#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { confirm, select } from "@inquirer/prompts";
import { launchNativeLoginBrowser } from "../browser/native-login.js";
import {
  createWebAdapter,
  DEFAULT_PROVIDER,
  getProvider,
  getProviderProfileDir,
  isProviderProfileBasename,
  listActiveProviderIds,
  resolveProvider,
} from "../browser/provider-registry.js";
import {
  ensureDirectory,
  getAppDataDir,
  getSessionsDir,
  getTasksDir,
} from "../platform/paths.js";
import { discoverChromeExecutable } from "../platform/chrome-discovery.js";
import { isProcessAlive } from "../browser/cdp-state.js";
import {
  assertNativeRuntimeSupported,
  collectDoctorReport,
} from "../platform/windows-diagnostics.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { AgentSession } from "../session/agent-session.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { ApprovalStore } from "../policy/approval-store.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { ProcessManager } from "../tools/process-manager.js";
import { resolveLimits } from "../shared/limits.js";
import { EXPORTERS } from "../session/session-export.js";
import { getPackageVersion } from "../shared/package-info.js";
import { extractAtMentions } from "./at-files.js";
import {
  classifyChatInput,
  promptForConfirm,
  promptForText,
  promptForSelect,
  readChatMessage,
  ShellChatInput,
} from "./prompt-input.js";
import { createRenderer } from "./render-events.js";
import { t } from "./i18n.js";
import { runSelfUpdate } from "./self-update.js";
import { runStartupChecks } from "./startup-notices.js";

// Resolves the app data dir, the provider's dedicated Chrome profile dir, and
// the sessions dirs. `providerId` selects which profile directory is used
// (each provider logs in independently); an explicit `--profile-dir` still
// overrides it. Defaults to the ChatGPT profile so callers that predate
// multi-provider support are unaffected.
function resolveRuntimePaths(options, providerId = DEFAULT_PROVIDER) {
  const appDataDir = path.resolve(options.home ?? getAppDataDir());
  return {
    appDataDir,
    profileDir: path.resolve(
      options.profileDir ?? getProviderProfileDir(appDataDir, providerId),
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
  const provider = resolveProvider(options.model ?? DEFAULT_PROVIDER);
  const { profileDir } = resolveRuntimePaths(options, provider.id);
  const { label, baseUrl } = provider;
  for (;;) {
    console.log(t("login.openingProfile", { profileDir }));
    console.log(t("login.finishSignIn", { provider: label }));
    const browser = await launchNativeLoginBrowser({
      profileDir,
      chromePath: options.chromePath,
      url: baseUrl,
    });

    try {
      const answer = await promptForText({
        message: t("login.pressEnterVerify", { provider: label }),
      });
      if (answer == null) {
        return;
      }
      console.log(t("login.savingProfile"));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await browser.close();
    }

    const verifier = createWebAdapter({
      provider,
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
        console.log(t("login.verified", { provider: label }));
        return;
      }
    } finally {
      await verifier.close();
    }

    console.log(t("login.stillGuest", { provider: label }));
  }
}

// Resets local login by deleting the dedicated Chrome profile. Login state for
// this app lives entirely in that profile (provider cookies + localStorage), so
// removing it returns wtagent to a clean guest state — useful for testing the
// full login → run flow. It never touches the real account server-side.
async function runLogout(options) {
  // `logout` targets one provider's profile; unknown ids are rejected but a
  // "planned" provider is still allowed (its profile may exist from a prior
  // login attempt), so use getProvider rather than resolveProvider.
  const provider = getProvider(options.model ?? DEFAULT_PROVIDER);
  const { profileDir } = resolveRuntimePaths(options, provider.id);
  const exists = await fs.stat(profileDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!exists) {
    console.log(t("logout.none", { profileDir }));
    return;
  }

  // Guard: only ever delete something that is actually a dedicated profile.
  // A profile Chrome has used contains a "Default" profile directory; otherwise
  // require a known provider profile basename before removing.
  const looksLikeProfile = await fs.stat(path.join(profileDir, "Default"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!looksLikeProfile && !isProviderProfileBasename(path.basename(profileDir))) {
    throw new Error(t("logout.refuse", { profileDir }));
  }

  if (!options.yes) {
    const confirmed = await confirm({
      message: t("logout.confirm", {
        provider: provider.label,
        profileDir,
      }),
      default: false,
    });
    if (!confirmed) {
      console.log(t("logout.cancelled"));
      return;
    }
  }

  await fs.rm(profileDir, { recursive: true, force: true });
  console.log(t("logout.done", { profileDir }));
  console.log(
    provider.id === DEFAULT_PROVIDER
      ? t("logout.loginAgainDefault")
      : t("logout.loginAgainProvider", { provider: provider.id }),
  );
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
  const hasWarnings = report.items.some((item) => item.status === "degraded");
  console.log(
    report.exitCode !== 0
      ? "Doctor: FAILED"
      : hasWarnings
        ? "Doctor: OK (with warnings)"
        : "Doctor: OK",
  );
  process.exitCode = report.exitCode;
}

// Owns the browser adapter, process manager, and renderer for the lifetime of
// one conversation. A single instance drives many turns: the first turn boots
// the session, and each later turn reuses the same open Chrome tab and session
// state via runtime.run({ resume: true }).
class ConversationRunner {
  constructor({ session, options, interactive = false }) {
    this.session = session;
    this.options = options;
    // A conversation belongs to exactly one provider (recorded at creation).
    // The profile dir and adapter follow from it, so resumes reuse the right
    // login even when the CLI is invoked without --model.
    const provider = resolveProvider(session.state.provider ?? DEFAULT_PROVIDER);
    this.provider = provider;
    this.interactive = interactive;
    this.paths = resolveRuntimePaths(options, provider.id);
    this.limits = resolveLimits({
      modelTurnTimeoutMs: options.modelTurnTimeoutMs,
    });
    this.processManager = new ProcessManager();
    this.renderer = createRenderer({ providerLabel: provider.label });
    // "Always allow" decisions are scoped to this saved session. They persist
    // across turns and `resume`, but never carry over into a different session.
    this.approvalStore = new ApprovalStore({
      filePath: path.join(this.session.directory, "approvals.json"),
    });
    this.adapter = createWebAdapter({
      provider,
      profileDir: this.paths.profileDir,
      chromePath: options.chromePath,
      debug: options.debug,
      // Minimize by default; `--no-minimize` sets options.minimize === false.
      minimized: options.minimize !== false,
      // ESC cancels the in-flight turn while the model is processing. Only in
      // interactive TTY sessions where stdin is available to listen on.
      cancelOnEsc: interactive,
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
      policy: new PolicyEngine({ store: this.approvalStore }),
      session: this.session,
      limits: this.limits,
      postAuthSetup: (
        this.interactive
          ? async ({ adapter }) => {
            this.renderer.stopSpinner();
            await adapter.restoreWindow?.();
            try {
              const answer = await promptForText({
                message: t("model.chooseInBrowser", {
                  provider: this.provider.label,
                }),
              });
              if (answer == null) {
                throw new Error(t("model.setupCancelled"));
              }
            } finally {
              await adapter.minimizeWindow?.();
            }
          }
          : null
      ),
      approval: async ({ toolCall, reasons }) => {
        this.renderer.stopSpinner();
        console.log(
          `\n${"\x1b[33m"}${t("approval.required", { tool: toolCall.name })}${"\x1b[0m"}`,
        );
        for (const reason of reasons) {
          console.log(`- ${reason}`);
        }
        console.log(JSON.stringify(toolCall.args, null, 2));
        const choice = await select({
          message: t("approval.how"),
          choices: [
            { name: t("approval.once"), value: "once" },
            {
              name: t("approval.alwaysTool", { tool: toolCall.name }),
              value: "always-tool",
            },
            { name: t("approval.alwaysAll"), value: "always-all" },
            { name: t("approval.deny"), value: "deny" },
          ],
        });
        if (choice === "deny") {
          return false;
        }
        if (choice === "always-tool") {
          this.approvalStore.setAlwaysAllowedTool(toolCall.name);
          await this.approvalStore.save();
          console.log(t("approval.savedTool", {
            tool: toolCall.name,
            file: this.approvalStore.filePath,
          }));
        } else if (choice === "always-all") {
          this.approvalStore.setAlwaysAllowAll();
          await this.approvalStore.save();
          console.log(t("approval.savedAll", {
            file: this.approvalStore.filePath,
          }));
        }
        return true;
      },
      onEvent: (event) => this.renderer.handle(event),
    });
  }

  // Runs one turn. The first turn (resume=false) boots the session; later turns
  // resume the same conversation with a new user instruction. `files` are
  // resolved @file attachments for this turn's message.
  async runTurn({
    resume,
    instruction,
    files = [],
    inPlaceRecovery = false,
    mode = null,
  }) {
    const runtime = this.#buildRuntime();
    try {
      const result = await runtime.run({
        resume,
        instruction,
        files,
        inPlaceRecovery,
        mode,
      });
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
      if (error?.code === "TURN_CANCELLED") {
        // ESC during processing: the turn is cancelled but the conversation,
        // browser, and managed processes stay alive. Return to the prompt so
        // the user can send a new message or quit.
        this.renderer.stopSpinner();
        await this.session.update({
          phase: "interrupted",
          lastError: "Turn cancelled by user.",
        });
        await this.session.appendEvent("run.turn_cancelled", {
          message: "Turn cancelled by user.",
        });
        return { cancelled: true, error };
      }
      if (error?.code === "EMPTY_ASSISTANT_RETRIES_EXHAUSTED") {
        await this.session.update({
          phase: "awaiting_user",
          lastError: error.message,
        });
        const event = await this.session.appendEvent("run.recovery_required", {
          message: error.message,
          retries: error.details?.retries ?? null,
        });
        this.renderer.handle(event);
        return { recoveryRequired: true, error };
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

  // Closes the browser and stops managed processes. After a failed run the
  // browser is kept alive so the page state can be inspected: the saved CDP
  // state lets the next `wtagent resume` reuse the same window, and a later
  // launch reaps it if it has died in the meantime.
  async close({ keepBrowser = false } = {}) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.renderer.finish();
    await this.processManager.stopAll().catch(() => {});
    if (keepBrowser) {
      // Only offer to keep Chrome when this run actually launched one. A run
      // that failed before launch (e.g. the provider profile lock was held by
      // another live session) has no window to inspect.
      if (!this.adapter.cdpChrome) {
        return;
      }
      await this.adapter.detach().catch((error) => {
        console.error(`Warning: ${error.message}`);
      });
      console.log(
        "The run failed; Chrome was left open for debugging. "
          + "Inspect the page and close it manually, or just run "
          + "`wtagent resume` again — it will reuse this window.",
      );
      return;
    }
    await this.adapter.close().catch((error) => {
      console.error(`Warning: ${error.message}`);
    });
  }
}

async function waitForProcessToExit(pid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !isProcessAlive(pid);
}

// A live session holds the provider's Chrome profile lock. In an interactive
// session, ask the user how to proceed instead of failing outright: kill the
// other session, or have the user close its Chrome window so that session
// fails and releases the profile. Returns true when the turn should be retried.
async function promptToResolveProfileLock(error) {
  const pid = Number(error.details?.pid);
  console.log(`\n${"\x1b[33m"}${error.message}${"\x1b[0m"}`);
  const choice = await promptForSelect({
    message: t("profileLock.how"),
    choices: [
      { name: t("profileLock.kill"), value: "kill" },
      { name: t("profileLock.retry"), value: "retry" },
      { name: t("profileLock.quit"), value: "quit" },
    ],
  });
  if (choice == null || choice === "quit") {
    return false;
  }
  if (choice === "kill" && Number.isSafeInteger(pid) && pid > 0) {
    console.log(t("profileLock.stopping", { pid }));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    if (!await waitForProcessToExit(pid, 5_000)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  // Either the holder was killed or the user closed its Chrome window: wait
  // for the other session to release the profile, then retry the turn.
  await waitForProcessToExit(pid, 60_000);
  return true;
}

async function executeSession({
  session,
  options,
  resume = false,
  instruction = null,
  files = [],
  chatInput = null,
  mode = null,
}) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const interactive = !options.once && process.stdin.isTTY && process.stdout.isTTY;
  const runner = new ConversationRunner({ session, options, interactive });

  const onInterrupt = () => {
    if (runner.interrupted) {
      console.log(`\n${t("session.forceQuit")}`);
      // process.exit skips the finally block, so repeat the session/resume
      // hint here — the user should always know how to continue.
      console.log(t("session.savedAt", { directory: session.directory }));
      printResumeHint(session.sessionId);
      process.exit(130);
    }
    runner.interrupted = true;
    runner.adapter.escCancelRequested = true;
    runner.renderer.stopSpinner();
    console.log(`\n${t("session.ctrlC")}`);
    process.exitCode = 130;
  };
  process.on("SIGINT", onInterrupt);
  const activeChatInput = chatInput
    ?? (interactive ? new ShellChatInput() : null);
  if (instruction) {
    activeChatInput?.remember(instruction);
  }

  let runFailed = false;

  try {
    runner.renderer.hint(`Session ID: ${session.sessionId}`);
    let turnResume = resume;
    let turnInstruction = instruction;
    let turnFiles = files;
    let turnInPlaceRecovery = false;

    for (;;) {
      let result;
      try {
        result = await runner.runTurn({
          resume: turnResume,
          instruction: turnInstruction,
          files: turnFiles,
          inPlaceRecovery: turnInPlaceRecovery,
          mode,
        });
      } catch (error) {
        // Another live session holds the provider profile lock. Interactively,
        // offer to resolve it and retry the same turn; otherwise fail cleanly
        // (the top-level handler prints the actionable message).
        if (error?.code === "PROFILE_LOCKED" && interactive) {
          if (await promptToResolveProfileLock(error)) {
            continue;
          }
          return null;
        }
        throw error;
      }
      if (runner.interrupted) {
        break;
      }
      if (result?.cancelled) {
        if (!interactive) {
          throw result.error;
        }
        runner.renderer.hint(t("session.cancelledHint"));
        turnResume = true;
        turnInPlaceRecovery = false;
        continue;
      }
      if (result?.recoveryRequired) {
        if (!interactive) {
          throw result.error;
        }
        runner.renderer.hint(
          t("session.recoveryHint", {
            provider: runner.renderer.providerLabel,
          }),
        );
        const next = await promptForNextMessage(runner, activeChatInput);
        if (next == null) {
          break;
        }
        const retryOnly = next.text.trim().toLowerCase() === "/retry";
        if (!retryOnly) {
          await session.appendInstruction(next.text, { files: next.files });
        }
        turnResume = true;
        turnInstruction = retryOnly ? null : next.text;
        turnFiles = retryOnly ? [] : next.files;
        // This Chrome tab still contains the original message/tool result, so
        // the next run must not resend a persisted pending result.
        turnInPlaceRecovery = true;
        continue;
      }
      if (!interactive) {
        return result;
      }

      turnInPlaceRecovery = false;

      // Managed dev servers keep running between turns; surface them once.
      const running = runner.processManager.list({ includeOutput: false }).filter(
        (item) => item.status === "running",
      );
      if (running.length > 0) {
        runner.renderer.hint(t("session.processesRunning"));
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
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    activeChatInput?.close();
    await runner.close({ keepBrowser: runFailed });
    console.log(t("session.savedAt", { directory: session.directory }));
    printResumeHint(session.sessionId);
  }
}

// A highly visible, blank-line-separated hint for continuing the conversation,
// printed last so it is not lost in the run output (like Claude Code).
function printResumeHint(sessionId) {
  const rule = "─".repeat(48);
  console.log("");
  console.log(rule);
  console.log(t("session.resumeWith", { sessionId }));
  console.log(rule);
  console.log("");
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
        message: t("task.youPrompt"),
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
      t("attachment.attaching", {
        files: files.map((file) => file.name).join(", "),
      }),
    );
  }
  if (missing.length > 0) {
    runner.renderer.hint(
      t("attachment.notAttached", {
        details: missing.map((m) => `${m.requested}: ${m.reason}`).join("; "),
      }),
    );
  }
  return files;
}

function isInteractiveSession(options) {
  return !options.once && process.stdin.isTTY && process.stdout.isTTY;
}

async function promptForUpdate({ currentVersion, latest }) {
  return await promptForConfirm({
    message: t("update.prompt", { currentVersion, latest }),
    default: true,
  });
}

async function maybeRunStartupChecks(options) {
  return await runStartupChecks({
    appDataDir: resolveRuntimePaths(options).appDataDir,
    interactive: isInteractiveSession(options),
    promptUpdate: promptForUpdate,
  });
}

async function runUpdate() {
  const result = await runSelfUpdate();
  if (result.status === "error") {
    process.exitCode = 1;
  }
  return result;
}

async function runAgent(taskParts, options) {
  assertNativeRuntimeSupported();
  const projectRoot = path.resolve(options.project ?? process.cwd());
  await assertDirectory(projectRoot);

  // Fail fast on an unknown/unsupported --model before any startup work.
  const provider = resolveProvider(options.model ?? DEFAULT_PROVIDER);

  const startup = await maybeRunStartupChecks(options);
  if (startup === "updated" || startup === "aborted") {
    return null;
  }

  const interactive = isInteractiveSession(options);
  const chatInput = interactive ? new ShellChatInput() : null;

  if (interactive) {
    printChatBanner(projectRoot, provider);
  }

  // In interactive mode an initial task is optional: the user can just start
  // typing at the prompt. In one-shot mode a task is required.
  let task = taskParts.join(" ").trim();
  if (!task) {
    const initialMessage = interactive
      ? await readChatMessage(() => chatInput.read())
      : await promptForText({
        message: t("task.prompt"),
        validate: (value) => value.trim() ? true : t("task.required"),
      });
    if (initialMessage == null) {
      chatInput?.close();
      console.log("");
      return null;
    }
    task = initialMessage.trim();
  } else if (interactive) {
    chatInput.remember(task);
  }

  const paths = resolveRuntimePaths(options, provider.id);
  await ensureDirectory(paths.sessionsDir);
  const session = await AgentSession.create({
    sessionsDir: paths.sessionsDir,
    task,
    projectRoot,
    provider: provider.id,
    mode: null,
  });

  // Resolve @file attachments in the opening task, if any. The task itself is
  // already stored by AgentSession.create; here we only resolve the files to
  // attach on the first turn (run() records them on the opening user item).
  let files = [];
  if (task) {
    const { files: found, missing } = await extractAtMentions(task, projectRoot);
    files = found;
    if (found.length > 0) {
      console.log(t("attachment.attaching", {
        files: found.map((file) => file.name).join(", "),
      }));
    }
    if (missing.length > 0) {
      console.log(t("attachment.notAttached", {
        details: missing.map((m) => `${m.requested}: ${m.reason}`).join("; "),
      }));
    }
  }

  return await executeSession({ session, options, files, chatInput });
}

function printChatBanner(projectRoot, provider) {
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";
  console.log("");
  console.log(`${CYAN}WTAgent${RESET} ${DIM}· ${provider.label} · ${projectRoot}${RESET}`);
  console.log(`${DIM}${t("banner.controls")}${RESET}`);
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
  // Loading only needs the sessions dir (provider-independent); the provider is
  // then read from the session so the run reuses the right adapter + profile.
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const session = await loadSession(paths, sessionId);
  await assertDirectory(session.state.projectRoot);

  const provider = resolveProvider(session.state.provider ?? DEFAULT_PROVIDER);
  // A conversation belongs to one provider. --model on resume is only allowed
  // if it names the same provider; switching mid-conversation is rejected.
  if (options.model != null && getProvider(options.model).id !== provider.id) {
    throw new Error(
      `Session ${sessionId} uses ${provider.label}; `
        + `--model ${options.model} cannot change a conversation's provider.`,
    );
  }

  const startup = await maybeRunStartupChecks(options);
  if (startup === "updated" || startup === "aborted") {
    return null;
  }

  const instruction = instructionParts.join(" ").trim();
  let files = [];
  if (instruction) {
    const projectRoot = session.state.projectRoot;
    const { files: found, missing } = await extractAtMentions(instruction, projectRoot);
    files = found;
    if (found.length > 0) {
      console.log(t("attachment.attaching", {
        files: found.map((file) => file.name).join(", "),
      }));
    }
    if (missing.length > 0) {
      console.log(t("attachment.notAttached", {
        details: missing.map((m) => `${m.requested}: ${m.reason}`).join("; "),
      }));
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
    console.log(t("status.none"));
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
  .description(t("app.description"))
  .version(getPackageVersion())
  .option("--home <path>", t("option.home"))
  .option("--profile-dir <path>", t("option.profileDir"))
  .option("--chrome-path <path>", t("option.chromePath"))
  .option("-C, --project <path>", t("option.project"), process.cwd())
  .option(
    "--model <provider>",
    t("option.model", {
      providers: listActiveProviderIds().join(", "),
      defaultProvider: DEFAULT_PROVIDER,
    }),
  )
  .option("--once", t("option.once"), false)
  .option("--model-turn-timeout-ms <milliseconds>", t("option.timeout"))
  .option("--no-minimize", t("option.noMinimize"))
  .option("--debug", t("option.debug"), false)
  .argument("[task...]", t("argument.task"))
  .action(async (task, _, command) => {
    await runAgent(task, command.optsWithGlobals());
  });

program
  .command("update")
  .description(t("command.update"))
  .action(async () => runUpdate());

program
  .command("doctor")
  .description(t("command.doctor"))
  .action(async (_, command) => runDoctor(command.optsWithGlobals()));

program
  .command("login")
  .description(t("command.login"))
  .action(async (_, command) => runLogin(command.optsWithGlobals()));

program
  .command("logout")
  .description(t("command.logout"))
  .option("--yes", t("option.yes"), false)
  .action(async (options, command) => {
    await runLogout({ ...command.optsWithGlobals(), ...options });
  });

program
  .command("resume")
  .description(t("command.resume"))
  .argument("<session-id>", t("argument.sessionId"))
  .argument("[instruction...]", t("argument.instruction"))
  .action(async (sessionId, instruction, _, command) => {
    await runResume(
      sessionId,
      instruction,
      command.optsWithGlobals(),
    );
  });

program
  .command("status")
  .description(t("command.status"))
  .argument("[session-id]", t("argument.sessionId"))
  .action(async (sessionId, _, command) => {
    await runStatus(sessionId, command.optsWithGlobals());
  });

program
  .command("export")
  .description(t("command.export"))
  .argument("<session-id>", t("argument.sessionId"))
  .option("--format <name>", t("option.format"), "codex")
  .option("-o, --output <path>", t("option.output"))
  .action(async (sessionId, options, command) => {
    await runExport(sessionId, { ...command.optsWithGlobals(), ...options });
  });

program.parseAsync().catch((error) => {
  // Expected, actionable failures carry a plain message instead of a stack
  // trace (e.g. the provider's Chrome profile is locked by another session).
  if (error?.code === "PROFILE_LOCKED") {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}).finally(() => {
  // By the time every command finishes, all per-command cleanup (browser
  // detach/close, stdin raw-mode restore, process stop) has already run. A
  // stray tty handle (e.g. a keypress-machinery listener left behind on a
  // failed turn) can still pin the event loop, leaving a dead prompt that
  // never returns to the shell — exit hard instead of relying on the loop
  // to drain naturally.
  if (process.exitCode != null && process.exitCode !== 0) {
    process.stdin.setRawMode?.(false);
    process.stdin.pause?.();
    process.exit(process.exitCode);
  }
});
