import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator, displayLanguage, formatNumber, translate } from "../lib/i18n/index.js";
import { localeFromRequest, normalizeLocale, tmdbLocale } from "../lib/i18n/locales.js";
import { getGenreDefinitions, getMovieDetails } from "../lib/metadata/tmdb.js";

test("normalizes supported app and TMDB locales with English as the default", () => {
  assert.equal(normalizeLocale("mk-MK"), "mk");
  assert.equal(normalizeLocale("en_US"), "en");
  assert.equal(normalizeLocale("de"), "en");
  assert.equal(tmdbLocale("mk"), "mk-MK");
  assert.equal(tmdbLocale("unknown"), "en-US");
});

test("reads a validated device locale from the request cookie", () => {
  assert.equal(localeFromRequest(new Request("http://localhost", {
    headers: { cookie: "session=value; torplay_locale=mk; another=value" },
  })), "mk");
  assert.equal(localeFromRequest(new Request("http://localhost", {
    headers: { cookie: "torplay_locale=fr" },
  })), "en");
});

test("translates Macedonian UI copy, variables, patterns, and formatting", () => {
  const t = createTranslator("mk");
  assert.equal(t("Settings"), "Поставки");
  assert.equal(t("Delete {name}", { name: "Ana" }), "Избриши го профилот Ana");
  assert.equal(t("Season 4"), "Сезона 4");
  assert.equal(translate("en", "Settings"), "Settings");
  assert.equal(formatNumber("mk", 1234), new Intl.NumberFormat("mk-MK").format(1234));
  assert.ok(displayLanguage("mk", "en").toLocaleLowerCase("mk").includes("анг"));
});

test("translates settings, source, and catalog labels shown in Macedonian", () => {
  const t = createTranslator("mk");
  assert.equal(t("Video Sources"), "Видеоизвори");
  assert.equal(t("TV / Series"), "ТВ / Серии");
  assert.equal(t("OPTIONAL"), "ИЗБОРНО");
  assert.equal(t("Optional"), "Изборно");
  assert.equal(t("Valid"), "Валидно");
  assert.equal(t("Connection verified."), "Врската е потврдена.");
  assert.equal(t("Disable"), "Исклучи");
  assert.equal(t("Show OpenSubtitles API key"), "Прикажи го API клучот за OpenSubtitles");
  assert.equal(t("Verifying…"), "Се проверува…");
  assert.equal(t("Remove EZTV?"), "Да се отстрани EZTV?");
  assert.equal(t("Movie-focused torrent search with multiple quality options."),
    "Torrent пребарување за филмови со повеќе опции за квалитет.");
});

test("Macedonian TMDB details fall back to English fields and retain an English source title", async () => {
  const previousToken = process.env.TMDB_API_TOKEN;
  process.env.TMDB_API_TOKEN = "tmdb-secret";
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.searchParams.get("language"));
    const macedonian = parsed.searchParams.get("language") === "mk-MK";
    return new Response(JSON.stringify({
      id: 10,
      title: macedonian ? "Македонски наслов" : "English Title",
      original_title: "Original Title",
      overview: macedonian ? "" : "English overview",
      genres: [{ id: 18, name: macedonian ? "Драма" : "Drama" }],
    }), { status: 200 });
  };
  try {
    const movie = await getMovieDetails(10, { locale: "mk", fetchImpl, usePersistentCache: false });
    assert.deepEqual(requests, ["mk-MK", "en-US"]);
    assert.equal(movie.title, "Македонски наслов");
    assert.equal(movie.sourceTitle, "English Title");
    assert.equal(movie.originalTitle, "Original Title");
    assert.equal(movie.overview, "English overview");
    assert.deepEqual(movie.genres, ["Драма"]);
  } finally {
    if (previousToken === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
});

test("localized genres keep English URL slugs", async () => {
  const previousToken = process.env.TMDB_API_TOKEN;
  process.env.TMDB_API_TOKEN = "tmdb-secret";
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const macedonian = parsed.searchParams.get("language") === "mk-MK";
    return new Response(JSON.stringify({
      genres: [{ id: 27, name: macedonian ? "Хорор" : "Horror" }],
    }), { status: 200 });
  };
  try {
    const genres = await getGenreDefinitions("movie", { locale: "mk", fetchImpl, usePersistentCache: false });
    assert.equal(genres[0].slug, "horror");
    assert.equal(genres[0].name, "Хорор");
  } finally {
    if (previousToken === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
});
