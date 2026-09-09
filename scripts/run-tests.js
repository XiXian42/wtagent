import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Node versions differ in directory discovery and glob support. Pass the test
// files explicitly so Windows shells and hidden generated projects cannot
// change the suite that `npm test` executes.
const directory = fileURLToPath(new URL("../test/", import.meta.url));
const files = (await fs.readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(directory, entry.name))
  .sort();
const result = spawnSync(process.execPath, [
  "--test",
  ...process.argv.slice(2),
  ...files,
], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
}
process.exitCode = result.status ?? 1;
