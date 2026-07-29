import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseModeOption,
  slugMatchesToken,
  normalizeToken,
  runModeSelection,
} from "../src/browser/mode-selection.js";

// A realistic menu in DOM order. Slugs are stable, language-independent
// attribute values; labels are localized and must NOT drive selection.
function menu({ proDisabled = false, includePro = true } = {}) {
  const options = [
    { index: 0, slug: "model-switcher-gpt-4o", label: "GPT-4o", disabled: false },
    { index: 1, slug: "model-switcher-o3-extra-high", label: "Extra high", disabled: false },
  ];
  if (includePro) {
    options.push({ index: options.length, slug: "model-switcher-pro", label: "专业版", disabled: proDisabled });
  }
  return options.map((option, index) => ({ ...option, index }));
}

test("slug matching ignores display text and is language independent", () => {
  assert.equal(slugMatchesToken("model-switcher-pro", "pro"), true);
  // Localized label is irrelevant; only the slug matters.
  assert.equal(slugMatchesToken("provider-picker", "pro"), false, "short token must match a whole segment");
  assert.equal(slugMatchesToken("o3-extra-high", normalizeToken("Extra high")), true);
});

test("selects Pro when it is enabled", () => {
  const choice = chooseModeOption(menu(), "Pro");
  assert.equal(choice.status, "select");
  assert.equal(choice.targetIndex, 2);
});

test("falls back to the previous option when Pro is limited", () => {
  const choice = chooseModeOption(menu({ proDisabled: true }), "Pro");
  assert.equal(choice.status, "fallback");
  assert.equal(choice.targetIndex, 1);
  assert.equal(choice.selectedLabel, "Extra high");
});

test("reports unavailable when Pro is absent", () => {
  const choice = chooseModeOption(menu({ includePro: false }), "Pro");
  assert.equal(choice.status, "unavailable");
  assert.equal(choice.targetIndex, null);
});

test("reports when Pro is limited and the previous option is also disabled", () => {
  const options = [
    { index: 0, slug: "a", label: "A", disabled: true },
    { index: 1, slug: "model-switcher-pro", label: "Pro", disabled: true },
  ];
  const choice = chooseModeOption(options, "Pro");
  assert.equal(choice.status, "unavailable_disabled");
});

// ---- runModeSelection orchestration (retry + fallback via a fake port) ----

function fakePort(overrides = {}) {
  const calls = { openMenu: 0, clickOption: [], diagnostics: [] };
  return {
    calls,
    alreadyOnMode: async () => false,
    hasSwitcher: async () => true,
    openMenu: async () => { calls.openMenu += 1; },
    readOptions: async () => menu(),
    clickOption: async (index) => { calls.clickOption.push(index); return true; },
    waitClosed: async () => true,
    closeMenu: async () => {},
    writeDiagnostics: async (label) => { calls.diagnostics.push(label); },
    ...overrides,
  };
}

test("retries when the menu first reads empty (Radix async populate race)", async () => {
  let reads = 0;
  const port = fakePort({
    readOptions: async () => {
      reads += 1;
      return reads === 1 ? [] : menu();
    },
  });
  const result = await runModeSelection(port, "Pro");
  assert.equal(result.status, "select");
  assert.equal(result.attempts, 2);
  assert.equal(port.calls.openMenu, 2);
});

test("returns fallback result the runtime can surface without throwing", async () => {
  const port = fakePort({ readOptions: async () => menu({ proDisabled: true }) });
  const result = await runModeSelection(port, "Pro");
  assert.equal(result.status, "fallback");
  assert.equal(port.calls.clickOption.at(-1), 1);
});

test("skips work when already on the requested mode", async () => {
  const port = fakePort({ alreadyOnMode: async () => true });
  const result = await runModeSelection(port, "Pro");
  assert.equal(result.status, "already");
  assert.equal(port.calls.openMenu, 0);
});

test("reports missing switcher instead of throwing", async () => {
  const port = fakePort({ hasSwitcher: async () => false });
  const result = await runModeSelection(port, "Pro");
  assert.equal(result.status, "switcher_not_found");
  assert.deepEqual(port.calls.diagnostics, ["mode-switcher-not-found"]);
});
