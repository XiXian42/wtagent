import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

let cached;

export function getPackageInfo() {
  cached ??= JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  return cached;
}

export function getPackageName() {
  return getPackageInfo().name;
}

export function getPackageVersion() {
  return getPackageInfo().version;
}
