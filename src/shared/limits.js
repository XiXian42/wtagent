export const DEFAULT_LIMITS = Object.freeze({
  maxTurns: 36,
  maxProtocolErrors: 3,
  modelTurnTimeoutMs: 10 * 60_000,
  modelStableWindowMs: 1_500,
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
