import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "--test",
  "test/native-image.test.js",
  "test/image-generation.test.js",
  "test/music-generation.test.js",
  "test/rendered-text.test.js",
], {
  stdio: "inherit",
  env: { ...process.env, WTAGENT_DOM_TESTS: "1" },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
