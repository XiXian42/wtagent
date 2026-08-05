// Language-independent model/mode selection logic for the ChatGPT web picker.
//
// Prefer language-independent option slugs derived from data-testid / data-* /
// id. Current ChatGPT menus sometimes omit every such attribute, including on
// the Pro item, so an exact normalized label match is kept as a conservative
// fallback. We never use fuzzy label matching.
//
// This module is pure and DOM-free so it can be unit-tested without a browser.
// The adapter supplies a small "port" of async DOM operations to
// `runModeSelection`; all the retry / fallback policy lives here.

export function slugTokens(slug) {
  return String(slug ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Does the option's stable slug encode the requested mode token?
// `token` is a normalized (separator-free) string, e.g. "pro" or "extrahigh".
// Short tokens (< 4 chars, e.g. "pro") require an exact whole-segment match so
// "pro" does not match "provider". Longer tokens also allow a substring match
// against the separator-free slug, so a multi-word mode like "Extra high"
// (-> "extrahigh") matches a hyphenated slug like "o3-extra-high".
export function slugMatchesToken(slug, token) {
  if (!token) {
    return false;
  }
  const tokens = slugTokens(slug);
  if (tokens.includes(token)) {
    return true;
  }
  if (token.length >= 4) {
    const joined = tokens.join("");
    return joined.includes(token) || tokens.some((candidate) => candidate.includes(token));
  }
  return false;
}

function labelMatchesToken(label, token) {
  return String(label ?? "")
    .split(/\r?\n/)
    .some((line) => normalizeToken(line) === token);
}

// Given the enumerated menu options and the requested mode, decide what to do.
// options: [{ index, slug, label, disabled }] in DOM order.
// Returns { status, targetIndex, selectedLabel, reason }.
//   status "select"              -> requested mode is available; click it.
//   status "fallback"            -> requested mode is limited/disabled; click
//                                   the option immediately before it.
//   status "unavailable"         -> requested mode is not present in the menu.
//   status "unavailable_disabled"-> requested mode is disabled and the previous
//                                   option is not selectable either.
export function chooseModeOption(options, requested) {
  const token = normalizeToken(requested);
  let proIndex = options.findIndex(
    (option) => slugMatchesToken(option.slug, token),
  );
  if (proIndex === -1) {
    proIndex = options.findIndex(
      (option) => labelMatchesToken(option.label, token),
    );
  }

  if (proIndex === -1) {
    return {
      status: "unavailable",
      targetIndex: null,
      selectedLabel: null,
      reason: `"${requested}" is not in the model menu.`,
    };
  }

  const pro = options[proIndex];
  if (!pro.disabled) {
    return {
      status: "select",
      targetIndex: proIndex,
      selectedLabel: pro.label || requested,
      reason: `Selecting ${requested}.`,
    };
  }

  // Pro is present but limited. Fall back to the option immediately before it.
  const previous = options[proIndex - 1];
  if (previous && !previous.disabled) {
    return {
      status: "fallback",
      targetIndex: proIndex - 1,
      selectedLabel: previous.label || `option ${proIndex}`,
      reason: `${requested} is limited; selecting the previous option `
        + `"${previous.label || proIndex - 1}" instead.`,
    };
  }

  return {
    status: "unavailable_disabled",
    targetIndex: null,
    selectedLabel: null,
    reason: previous
      ? `${requested} is limited and the previous option is also unavailable.`
      : `${requested} is limited and has no previous option to fall back to.`,
  };
}

// Orchestrates selection against a DOM "port". Never throws for mode issues:
// it always resolves to a structured result the runtime can surface to the CLI,
// so a limited/absent Pro degrades gracefully instead of aborting the run.
//
// port: {
//   alreadyOnMode(requested) -> bool,
//   hasSwitcher()            -> bool,
//   openMenu()               -> void,
//   readOptions()            -> [{index, slug, label, disabled}],
//   clickOption(index)       -> bool (click landed),
//   waitClosed()             -> bool (menu closed after click),
//   closeMenu()              -> void,
//   writeDiagnostics(label)  -> void,
// }
export async function runModeSelection(port, requested, { maxAttempts = 2 } = {}) {
  if (!requested) {
    return { status: "skipped", requested, attempts: 0, reason: "No mode requested." };
  }

  if (await port.alreadyOnMode(requested)) {
    return {
      status: "already",
      requested,
      selectedLabel: requested,
      attempts: 0,
      reason: `Already using ${requested}.`,
    };
  }

  if (!await port.hasSwitcher()) {
    await port.writeDiagnostics("mode-switcher-not-found");
    return {
      status: "switcher_not_found",
      requested,
      attempts: 0,
      reason: "Model switcher was not found.",
    };
  }

  let lastReason = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await port.openMenu();
    const options = await port.readOptions();

    // The Radix menu populates asynchronously; an empty read is a race, retry.
    if (!options || options.length === 0) {
      lastReason = "Model menu did not populate in time.";
      await port.closeMenu();
      continue;
    }

    const choice = chooseModeOption(options, requested);

    if (choice.status === "select" || choice.status === "fallback") {
      const clicked = await port.clickOption(choice.targetIndex);
      const closed = clicked && await port.waitClosed();
      if (closed) {
        return { ...choice, requested, attempts: attempt };
      }
      lastReason = "The option click did not register.";
      await port.closeMenu();
      continue;
    }

    await port.closeMenu();

    // A genuinely absent Pro might still be populating on the first pass, so
    // retry once; a disabled Pro will not change, so report immediately.
    if (choice.status === "unavailable" && attempt < maxAttempts) {
      lastReason = choice.reason;
      continue;
    }

    await port.writeDiagnostics(`mode-${requested}-${choice.status}`);
    return { ...choice, requested, attempts: attempt };
  }

  await port.writeDiagnostics(`mode-${requested}-unresolved`);
  return {
    status: "unresolved",
    requested,
    attempts: maxAttempts,
    reason: lastReason || `Could not select ${requested}.`,
  };
}
