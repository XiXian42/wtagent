export const NETWORK_TIMEOUT_MS = 2_000;

export async function fetchJson(url, {
  timeoutMs = NETWORK_TIMEOUT_MS,
  fetchImpl = fetch,
  headers = { "User-Agent": "wtagent", Accept: "application/json" },
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
