import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_KEYS,
  SUPPORTED_LOCALES,
  createI18n,
  hasNativeTranslation,
  resolveLocale,
} from "../src/cli/i18n.js";

test("all supported locales have native translations for every CLI message", () => {
  assert.equal(SUPPORTED_LOCALES.length, 10);
  assert.ok(MESSAGE_KEYS.length > 0);

  for (const locale of SUPPORTED_LOCALES) {
    const missing = MESSAGE_KEYS.filter(
      (key) => !hasNativeTranslation(locale, key),
    );
    assert.deepEqual(
      missing,
      [],
      `${locale} is missing native translations: ${missing.join(", ")}`,
    );
  }
});

test("locale resolution follows common system language tags", () => {
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("zh_CN.UTF-8"), "zh-CN");
  assert.equal(resolveLocale("zh-Hans-SG"), "zh-CN");
  assert.equal(resolveLocale("zh_TW.UTF-8"), "zh-TW");
  assert.equal(resolveLocale("zh-Hant-HK"), "zh-TW");
  assert.equal(resolveLocale("ja-JP"), "ja");
  assert.equal(resolveLocale("ko-KR"), "ko");
  assert.equal(resolveLocale("es-MX"), "es");
  assert.equal(resolveLocale("fr-CA"), "fr");
  assert.equal(resolveLocale("de-DE"), "de");
  assert.equal(resolveLocale("pt-BR"), "pt");
  assert.equal(resolveLocale("ru-RU"), "ru");
  assert.equal(resolveLocale("xx-YY"), "en");
});

test("model-selection guidance is localized and interpolates the provider", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const { t } = createI18n(locale);
    const message = t("model.chooseInBrowser", { provider: "ExampleAI" });
    assert.match(message, /ExampleAI/);
    assert.notEqual(message, "model.chooseInBrowser");
    assert.ok(message.length > "ExampleAI".length);
  }
});
