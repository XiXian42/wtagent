// ChatGPT renders plan/usage limit notices as ordinary assistant messages,
// localized per UI language. Matching one means "stop, not retry". Text
// patterns are the primary signal (a limit notice always says something
// recognizable); callers may additionally confirm via DOM features (e.g. the
// retry/upgrade button ChatGPT shows on the notice) to guard against protocol
// replies that merely mention "limit" in their content.
const USAGE_LIMIT_PATTERNS = [
  /reached (?:your )?(?:current )?(?:usage |plan )?limit/i,
  /hit (?:your )?(?:usage )?limit/i,
  /usage limit(?:s)? (?:reached|exceeded)/i,
  /limit(?:s)? reached/i,
  /已达(?:到)?(?:使用)?(?:次数|用量)?限额?/i,
  /已达(?:到)?(?:使用)?(?:次数|用量)?上限/i,
  /使用上限/i,
  /额度(?:已)?用尽/i,
];

export function isUsageLimitNotice(text) {
  const value = String(text ?? "");
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(value));
}
