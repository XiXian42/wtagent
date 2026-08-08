import test from "node:test";
import assert from "node:assert/strict";
import {
  CHATGPT_MODE_CHOICES,
  modeFromPromptChoice,
  normalizeConfiguredMode,
} from "../src/cli/mode-choice.js";

test("interactive mode choices offer Pro and the current web setting", () => {
  assert.deepEqual(
    CHATGPT_MODE_CHOICES.map(({ value }) => value),
    ["pro", "current"],
  );
  assert.equal(modeFromPromptChoice("pro"), "Pro");
  assert.equal(modeFromPromptChoice("current"), null);
});

test("configured mode accepts only Pro or Current", () => {
  assert.equal(normalizeConfiguredMode("pro"), "Pro");
  assert.equal(normalizeConfiguredMode("CURRENT"), null);
  assert.throws(
    () => normalizeConfiguredMode("Extra High"),
    /either "Pro" or "Current"/,
  );
});
