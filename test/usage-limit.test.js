import test from "node:test";
import assert from "node:assert/strict";
import { isUsageLimitNotice } from "../src/shared/usage-limit.js";

test("recognizes usage-limit notices in common UI languages", () => {
  assert.equal(isUsageLimitNotice("你已达到限额。请稍后重试。"), true);
  assert.equal(isUsageLimitNotice("已到达使用上限"), true);
  assert.equal(isUsageLimitNotice("额度已用尽"), true);
  assert.equal(
    isUsageLimitNotice("You've reached your limit. Please try again later."),
    true,
  );
  assert.equal(
    isUsageLimitNotice("You have reached your current usage limit."),
    true,
  );
  assert.equal(isUsageLimitNotice("Usage limit reached"), true);
  assert.equal(isUsageLimitNotice("You hit your usage limit for this window."), true);
});

test("does not flag ordinary content that merely mentions limits", () => {
  assert.equal(
    isUsageLimitNotice("The API limit is 100 requests per minute."),
    false,
  );
  assert.equal(
    isUsageLimitNotice("No usage limit applies to this tool."),
    false,
  );
  assert.equal(
    isUsageLimitNotice("We hit the limit of 5 retries, continuing."),
    false,
  );
  assert.equal(isUsageLimitNotice("<agent_response>XML</agent_response>"), false);
});
