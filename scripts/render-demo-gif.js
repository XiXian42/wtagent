#!/usr/bin/env node
// Illustrated replay of a verified offline fixture, never a live AI recording.
// Requires ImageMagick (magick). Run: node scripts/render-demo-gif.js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "docs/assets");
const options = { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 };
const escape = (value) => String(value).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function text(x, y, value, size = 36, fill = "#e8edf8", weight = 500) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" xml:space="preserve">${escape(value)}</text>`;
}
function box(x, y, width, height, fill = "#222e44", stroke = "#3b4862") {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="22" fill="${fill}" stroke="${stroke}"/>`;
}
function svg(body, height = 780, title = "WTAgent scripted local demo", background = "#182032") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title"><title id="title">${escape(title)}</title><rect width="1200" height="${height}" fill="${background}"/><g font-family="Arial, Helvetica, sans-serif">${body}</g></svg>`;
}
function frame(index, title, body) {
  const progress = [0, 1, 2, 3].map((step) =>
    `<rect x="${56 + step * 280}" y="207" width="264" height="5" rx="2" fill="${step <= index ? "#b9a9fb" : "#39465f"}"/>`).join("");
  return svg(text(56, 69, "WTAgent", 29, "#c2b4ff", 750) +
    text(393, 69, "OFFLINE REPLAY · REAL LOCAL TOOLS", 26, "#b7c6dd", 650) +
    text(56, 165, title, 57, "#ffffff", 750) + progress +
    box(56, 250, 1088, 378) + body +
    text(56, 692, "Predefined AI replies. Not an online recording.", 27, "#c1cbdd") +
    text(56, 739, "Verified local run. Playback does not represent execution speed.", 25, "#aebbd2"));
}
function demoFrames(report) {
  const original = report.source.before.match(/\.replace\([^\n]+/)[0].replace(/;$/, "");
  const fixed = report.source.after.match(/\.replace\([^\n]+/)[0].replace(/;$/, "");
  const baseline = `${report.baseline.passed} passed · ${report.baseline.failed} failed`;
  const result = `${report.verified.passed} passed · ${report.verified.failed} failed`;
  return [
    frame(0, "Give it a coding task.",
      text(92, 315, "YOU ASK", 27, "#b7c6dd", 650) +
      text(92, 397, "Fix repeated spaces", 56, "#ffffff", 700) +
      text(92, 471, "and run the tests.", 56, "#ffffff", 700) +
      text(92, 561, "“Hello   World” → “hello-world”", 36, "#c2b4ff")),
    frame(1, "Reproduce the bug.",
      text(92, 315, report.source.path, 30, "#b7c6dd") +
      text(92, 397, original, 53, "#ffffff", 650) +
      text(92, 462, "Only the first space is replaced.", 36, "#c1cbdd") +
      text(92, 563, baseline, 55, "#ffb8b1", 700)),
    frame(2, "Edit the actual file.",
      text(92, 313, "BEFORE", 27, "#b7c6dd", 650) +
      text(92, 388, original, 48, "#ffb8b1") +
      text(92, 472, "AFTER", 27, "#b7c6dd", 650) +
      text(92, 552, fixed, 48, "#aee4c7", 650)),
    frame(3, "Verify the result.",
      text(92, 323, "node --test slugify.test.js", 36, "#c1cbdd") +
      text(92, 425, result, 66, "#aee4c7", 750) +
      text(92, 506, "Source read back. Tests unchanged.", 36, "#e8edf8") +
      text(92, 574, `${report.runtimeToolCompletions} runtime tool operations verified.`, 33, "#c2b4ff")),
  ];
}
function socialCard() {
  const ink = "#182033", purple = "#6146dc", muted = "#566176";
  return svg(text(64, 62, "WTAgent", 32, purple, 750) +
    text(887, 62, "OPEN SOURCE · MIT", 23, muted, 650) +
    text(64, 151, "Turn web chats into", 68, ink, 750) +
    text(64, 235, "coding agents.", 78, purple, 750) +
    text(64, 310, "Turn ChatGPT Web into a Codex-style coding agent.", 32, ink, 650) +
    text(64, 367, "Turn Claude Web into a Claude Code-style coding agent.", 32, ink, 650) +
    box(64, 397, 1072, 103, "#eeeafb", "#ddd5f4") +
    text(86, 433, "ALSO SUPPORTS", 23, purple, 700) +
    text(86, 477, "DeepSeek · Gemini · Grok · Kimi · GLM", 34, purple, 700) +
    text(64, 549, "Read files · Edit code · Run tests · No API key", 28, muted, 650) +
    text(64, 601, "Independent CLI. Not an official Codex or Claude Code client.", 24, muted),
    630, "WTAgent — ChatGPT, Claude, DeepSeek, Gemini, Grok, Kimi and GLM for local coding", "#f7f8fb");
}
const { stdout } = await run(process.execPath, ["scripts/demo-session.js", "--json"], options);
const report = JSON.parse(stdout.trim());
assert.equal(report.kind, "offline-scripted-runtime-demo");
assert.equal(report.liveProvider, false);
assert.equal(report.actualLocalTools, true);
assert.deepEqual(report.baseline, { exitCode: 1, passed: 2, failed: 1 });
assert.deepEqual(report.verified, { exitCode: 0, passed: 3, failed: 0 });
assert.equal(report.runtimeToolCompletions, 5);
assert.deepEqual(report.steps.map((step) => step.name),
  ["fs.read", "terminal.exec", "fs.edit", "terminal.exec", "fs.read"]);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-site-assets-"));
try {
  const frames = demoFrames(report);
  const delays = [280, 320, 340, 480];
  const gifArgs = ["-loop", "0"];
  for (const [index, markup] of frames.entries()) {
    const vector = path.join(temporary, `frame-${index}.svg`);
    const raster = path.join(temporary, `frame-${index}.png`);
    await fs.writeFile(vector, markup);
    await run("magick", ["-background", "none", vector, "-resize", "1200x780", raster], options);
    gifArgs.push("-delay", String(delays[index]), raster);
  }
  const gif = path.join(temporary, "demo.gif");
  gifArgs.push("-layers", "Optimize", gif);
  await run("magick", gifArgs, options);
  const socialVector = path.join(temporary, "social-card.svg");
  const socialPng = path.join(temporary, "social-card.png");
  await fs.writeFile(socialVector, socialCard());
  await run("magick", ["-background", "none", socialVector, "-resize", "1200x630", socialPng], options);
  const gifBytes = (await fs.stat(gif)).size;
  const socialBytes = (await fs.stat(socialPng)).size;
  assert.ok(gifBytes < 4 * 1024 * 1024, "Demo GIF exceeded its 4 MiB budget");
  assert.ok(socialBytes < 800 * 1024, "Social card exceeded its 800 KiB budget");
  const dimensions = await run("magick", ["identify", "-format", "%wx%h", socialPng], options);
  assert.equal(dimensions.stdout, "1200x630");
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, "demo-poster.svg"), frames.at(-1));
  await fs.writeFile(path.join(assets, "demo-proof.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.copyFile(gif, path.join(assets, "demo.gif"));
  await fs.copyFile(socialVector, path.join(assets, "social-card.svg"));
  await fs.copyFile(socialPng, path.join(assets, "social-card.png"));
  console.log(JSON.stringify({
    verified: true, frames: frames.length, playbackSeconds: delays.reduce((a, b) => a + b, 0) / 100,
    gifBytes, socialBytes, socialDimensions: dimensions.stdout,
    outputs: ["demo.gif", "demo-poster.svg", "demo-proof.json", "social-card.svg", "social-card.png"],
  }));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
// Source SVGs and a sanitized proof record accompany the rendered assets.
