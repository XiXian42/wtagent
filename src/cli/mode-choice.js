export const CHATGPT_MODE_CHOICES = Object.freeze([
  Object.freeze({
    name: "Pro — select Pro for this conversation",
    value: "pro",
  }),
  Object.freeze({
    name: "Current — keep the current ChatGPT setting",
    value: "current",
  }),
]);

export function normalizeConfiguredMode(value) {
  const configured = String(value ?? "").trim();
  if (/^current$/i.test(configured)) {
    return null;
  }
  if (/^pro$/i.test(configured)) {
    return "Pro";
  }
  throw new Error('ChatGPT mode must be either "Pro" or "Current".');
}

export function modeFromPromptChoice(choice) {
  return choice === "pro" ? "Pro" : null;
}
