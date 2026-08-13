export const DEFAULT_LIMITS = Object.freeze({
  maxProtocolErrors: 3,
  maxEmptyAssistantRetries: 3,
  modelTurnTimeoutMs: 20 * 60_000,
  modelStableWindowMs: 1_500,
  emptyAssistantWindowMs: 10_000,
  // How long a sent message may sit with neither a reply node nor a stop
  // button before the request is treated as silently dead. ChatGPT keeps the
  // stop button visible during generation AND thinking, so a signal-free
  // window this long reliably means the request never started.
  deadRequestGraceMs: 60_000,
  loginTimeoutMs: 15 * 60_000,
  toolTimeoutMs: 2 * 60_000,
  maxToolOutputBytes: 4 * 1024,
  maxLocalToolLogBytes: 4 * 1024 * 1024,
  maxFileReadBytes: 16 * 1024,
  maxBrowserToolResultBytes: 24 * 1024,
  maxDirectoryEntries: 500,
  maxSearchResults: 200,
});

export function resolveLimits({ modelTurnTimeoutMs } = {}) {
  if (modelTurnTimeoutMs == null || modelTurnTimeoutMs === "") {
    return DEFAULT_LIMITS;
  }

  const parsed = Number(modelTurnTimeoutMs);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(
      "Model turn timeout must be a positive integer number of milliseconds.",
    );
  }

  return Object.freeze({
    ...DEFAULT_LIMITS,
    modelTurnTimeoutMs: parsed,
  });
}
