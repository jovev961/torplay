import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLED_SUBTITLE_LANGUAGES,
  getSubtitleLanguageCatalog,
} from "../lib/subtitles/languages.js";

const config = {
  opensubtitles: { apiKey: "secret-open-key", userAgent: "TorPlay tests" },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("uses and normalizes the OpenSubtitles language catalog first", async () => {
  const calls = [];
  const catalog = await getSubtitleLanguageCatalog({
    config,
    useCache: false,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        data: [
          { language_code: "DE", language_name: "German" },
          { language_code: "en", language_name: "English" },
          { language_code: "en", language_name: "Duplicate" },
          { language_code: "not valid", language_name: "Invalid" },
        ],
      });
    },
  });

  assert.equal(catalog.source, "opensubtitles");
  assert.deepEqual(catalog.languages, [
    { code: "en", label: "English" },
    { code: "de", label: "German" },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /opensubtitles\.com\/api\/v1\/infos\/languages/);
  assert.equal(calls[0].options.headers["Api-Key"], "secret-open-key");
});

test("falls back from OpenSubtitles to SubDL language metadata", async () => {
  const calls = [];
  const catalog = await getSubtitleLanguageCatalog({
    config,
    useCache: false,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return jsonResponse({}, 503);
      return jsonResponse({ EN: "English", MK: "Macedonian" });
    },
  });

  assert.equal(catalog.source, "subdl");
  assert.deepEqual(catalog.languages, [
    { code: "en", label: "English" },
    { code: "mk", label: "Macedonian" },
  ]);
  assert.match(calls[1], /subdl\.com\/api-files\/language_list\.json/);
});

test("uses the bundled broad catalog when both providers fail", async () => {
  const catalog = await getSubtitleLanguageCatalog({
    config,
    useCache: false,
    fetchImpl: async () => { throw new Error("offline"); },
  });

  assert.equal(catalog.source, "bundled");
  assert.equal(catalog.languages.length, BUNDLED_SUBTITLE_LANGUAGES.length);
  assert.equal(catalog.languages.some(({ code }) => code === "en"), true);
  assert.equal(catalog.languages.some(({ code }) => code === "mk"), true);
  assert.equal(catalog.languages.some(({ code }) => code === "de"), true);
});
