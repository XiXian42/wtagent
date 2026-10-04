import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "test/chatgpt-dom.test.js"], {
  stdio: "inherit",
  env: { ...process.env, WTAGENT_DOM_TESTS: "1" },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
