import { spawn } from "node:child_process";
import { buildToolEnvironment } from "./safe-env.js";
import { killProcessTree } from "./process-utils.js";

function appendLimited(current, chunk, maxBytes) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return { text: next, truncated: false };
  }
  return {
    text: next.slice(0, maxBytes),
    truncated: true,
  };
}

export async function runProgram({
  program,
  argv = [],
  cwd,
  timeoutMs,
  maxOutputBytes,
  inheritSensitiveEnv = false,
  onOutput,
}) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let terminationGuard = null;
    let outputQueue = Promise.resolve();

    const child = spawn(program, argv, {
      cwd,
      env: buildToolEnvironment({ inheritSensitive: inheritSensitiveEnv }),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: false,
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
      resolve({
        ...result,
        stdout,
        stderr,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
        durationMs: Date.now() - startedAt,
      });
    };

    const enqueueOutput = (output) => {
      outputQueue = outputQueue
        .then(() => onOutput?.(output))
        .catch(() => undefined);
    };

    child.stdout.on("data", (chunk) => {
      const appended = appendLimited(stdout, chunk, maxOutputBytes);
      stdout = appended.text;
      stdoutTruncated ||= appended.truncated;
      enqueueOutput({ stream: "stdout", chunk: chunk.toString("utf8") });
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendLimited(stderr, chunk, maxOutputBytes);
      stderr = appended.text;
      stderrTruncated ||= appended.truncated;
      enqueueOutput({ stream: "stderr", chunk: chunk.toString("utf8") });
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
