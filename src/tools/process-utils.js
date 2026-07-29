import { spawn } from "node:child_process";

export async function killProcessTree(pid, signal = "SIGTERM") {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const child = spawn(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      child.once("close", resolve);
      child.once("error", resolve);
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already be gone.
    }
  }
}

