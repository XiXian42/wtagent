import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildToolEnvironment } from "./safe-env.js";
import { killProcessTree } from "./process-utils.js";
import { resolveLaunchPlan } from "../platform/command-launcher.js";
import {
  utf8ByteLength,
  utf8Prefix,
  utf8Suffix,
} from "../shared/text-budget.js";

class StreamCapture {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.head = "";
    this.tail = "";
    this.totalBytes = 0;
  }

  append(text) {
    if (!text) return;
    const bytes = utf8ByteLength(text);
    this.totalBytes += bytes;

    const headRemaining = Math.max(0, this.maxBytes - utf8ByteLength(this.head));
    if (headRemaining > 0) {
      this.head += utf8Prefix(text, headRemaining);
    }
    this.tail = utf8Suffix(this.tail + text, this.maxBytes);
  }

  render(maxBytes) {
    if (this.totalBytes <= maxBytes) {
      return {
        text: this.head,
        truncated: false,
        originalBytes: this.totalBytes,
        includedBytes: this.totalBytes,
      };
    }

    let marker = "\n[WTAgent output truncated]\n";
    let head = "";
    let tail = "";
    for (let pass = 0; pass < 4; pass += 1) {
      const contentBudget = Math.max(0, maxBytes - utf8ByteLength(marker));
      const headBudget = Math.floor(contentBudget / 4);
      const tailBudget = contentBudget - headBudget;
      head = utf8Prefix(this.head, headBudget);
      tail = utf8Suffix(this.tail, tailBudget);
      const omittedBytes = Math.max(
        0,
        this.totalBytes - utf8ByteLength(head) - utf8ByteLength(tail),
      );
      marker = `\n[WTAgent omitted ${omittedBytes} bytes]\n`;
    }

    let text = `${head}${marker}${tail}`;
    if (utf8ByteLength(text) > maxBytes) {
      const markerBytes = utf8ByteLength(marker);
      const contentBudget = Math.max(0, maxBytes - markerBytes);
      const headBudget = Math.floor(contentBudget / 4);
      text = utf8Prefix(this.head, headBudget)
        + marker
        + utf8Suffix(this.tail, contentBudget - headBudget);
    }
    return {
      text,
      truncated: true,
      originalBytes: this.totalBytes,
      includedBytes: utf8ByteLength(text),
    };
  }
}

function allocateOutputBudgets({ stdoutBytes, stderrBytes, maxBytes, preferStderr }) {
  if (stdoutBytes + stderrBytes <= maxBytes) {
    return { stdout: stdoutBytes, stderr: stderrBytes };
  }
  if (stdoutBytes === 0) return { stdout: 0, stderr: maxBytes };
  if (stderrBytes === 0) return { stdout: maxBytes, stderr: 0 };

  const preferredBytes = preferStderr ? stderrBytes : stdoutBytes;
  const secondaryBytes = preferStderr ? stdoutBytes : stderrBytes;
  let preferred = Math.min(preferredBytes, Math.floor(maxBytes * 0.75));
  let secondary = Math.min(secondaryBytes, maxBytes - preferred);
  preferred += Math.min(preferredBytes - preferred, maxBytes - preferred - secondary);
  secondary += Math.min(secondaryBytes - secondary, maxBytes - preferred - secondary);

  return preferStderr
    ? { stdout: secondary, stderr: preferred }
    : { stdout: preferred, stderr: secondary };
}

export async function runProgram({
  program,
  argv = [],
  cwd,
  timeoutMs,
  maxOutputBytes,
  maxLogBytes = 4 * 1024 * 1024,
  inheritSensitiveEnv = false,
  onOutput,
  spawnImpl = spawn,
  platform = process.platform,
  resolveLaunchPlanImpl = resolveLaunchPlan,
}) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutCapture = new StreamCapture(maxOutputBytes);
    const stderrCapture = new StreamCapture(maxOutputBytes);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let loggedBytes = 0;
    let logTruncated = false;
    let timedOut = false;
    let settled = false;
    let terminationGuard = null;
    let outputQueue = Promise.resolve();
    const environment = buildToolEnvironment({ inheritSensitive: inheritSensitiveEnv });
    const launchPlan = resolveLaunchPlanImpl({
      program,
      argv,
      cwd,
      env: environment,
      platform,
    });

    const child = spawnImpl(launchPlan.command, launchPlan.args, {
      cwd,
      env: environment,
      shell: launchPlan.shell,
      detached: platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: launchPlan.windowsVerbatimArguments === true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = async (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationGuard);
      await outputQueue;
      const budgets = allocateOutputBudgets({
        stdoutBytes: stdoutCapture.totalBytes,
        stderrBytes: stderrCapture.totalBytes,
        maxBytes: maxOutputBytes,
        preferStderr: !result.ok,
      });
      const stdout = stdoutCapture.render(budgets.stdout);
      const stderr = stderrCapture.render(budgets.stderr);
      resolve({
        ...result,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        stdoutBytes: stdout.originalBytes,
        stderrBytes: stderr.originalBytes,
        includedOutputBytes: stdout.includedBytes + stderr.includedBytes,
        loggedOutputBytes: loggedBytes,
        logTruncated,
        durationMs: Date.now() - startedAt,
      });
    };

    const enqueueOutput = (stream, text) => {
      if (!text || !onOutput) return;
      const remaining = Math.max(0, maxLogBytes - loggedBytes);
      if (remaining === 0) {
        logTruncated = true;
        return;
      }
      const chunk = utf8Prefix(text, remaining);
      const chunkBytes = utf8ByteLength(chunk);
      loggedBytes += chunkBytes;
      if (chunkBytes < utf8ByteLength(text)) {
        logTruncated = true;
      }
      outputQueue = outputQueue
        .then(() => onOutput({ stream, chunk }))
        .catch(() => undefined);
    };

    child.stdout.on("data", (chunk) => {
      const text = stdoutDecoder.write(chunk);
      stdoutCapture.append(text);
      enqueueOutput("stdout", text);
    });
    child.stderr.on("data", (chunk) => {
      const text = stderrDecoder.write(chunk);
      stderrCapture.append(text);
      enqueueOutput("stderr", text);
    });
    child.stdout.on("end", () => {
      const text = stdoutDecoder.end();
      stdoutCapture.append(text);
      enqueueOutput("stdout", text);
    });
    child.stderr.on("end", () => {
      const text = stderrDecoder.end();
      stderrCapture.append(text);
      enqueueOutput("stderr", text);
    });

    child.once("error", (error) => {
      void finish({
        ok: false,
        exitCode: null,
        signal: null,
        error,
      });
    });
    child.once("close", (exitCode, signal) => {
      void finish({
        ok: !timedOut && exitCode === 0,
        exitCode,
        signal,
      });
    });

    const timer = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child.pid);

      if (settled) {
        return;
      }

      terminationGuard = setTimeout(() => {
        void finish({
          ok: false,
          exitCode: null,
          signal: null,
          completionUnknown: true,
        });
      }, 1_000);
      terminationGuard.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}
