import assert from "node:assert/strict";
import test from "node:test";
import { findAuthorizedSources as findSources, startBestVerifiedSource as startBest } from "../lib/search/service.js";
import { getSearchResult } from "../lib/search/result-store.js";

function dependencies(options) {
  const { searchProvider, ...rest } = options;
  return { ...rest, onFailure: () => {}, providers: [{ id: "fake", name: "Fake", search: searchProvider }] };
}
const findAuthorizedSources = (context, options) => findSources(context, dependencies(options));
const startBestVerifiedSource = (context, options) => startBest(context, dependencies(options));

const hash = "0123456789012345678901234567890123456789";
const magnet = `magnet:?xt=urn:btih:${hash}`;
function candidate(title, seeders = 10, infoHash = hash) {
  return {
    title, seeders, infoHash: infoHash === hash ? hash : infoHash.padEnd(40, "0").replace(/[^a-f0-9]/g, "a"), size: 1000, indexer: "Fake provider",
    source: { downloadUrl: "https://provider.test/torrent?apikey=secret" },
    privatePayload: "secret",
  };
}

test("shared search accepts a replacement provider, filters, deduplicates, and projects safe results", async () => {
  let calls = 0;
  const mediaContext = { title: "  Sintel  ", type: "movie", tmdbId: 123 };
  const results = await findAuthorizedSources(mediaContext, {
    searchProvider: async (context) => {
      assert.equal(context.title, "Sintel");
      return [candidate("Sintel 720p"), candidate("Sintel duplicate"),
        candidate("Other film", 100, "other"), candidate("Sintel 1080p", 20, "second")];
    },
    inspectSource: async (source) => {
      calls += 1;
      assert.equal(source.mediaContext.tmdbId, 123);
      return {};
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(results.map((item) => item.title), ["Sintel 1080p", "Sintel 720p"]);
  const serialized = JSON.stringify(results);
  for (const privateValue of ["secret", "magnet:", "downloadUrl", "privatePayload"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.equal(results[0].hasMagnet, true);
  assert.equal(results[0].verification, "verified");
  assert.equal(getSearchResult(results[0].id).magnet, `magnet:?xt=urn:btih:${results[0].infoHash}`);
});

test("shared validation rejects invalid requests before invoking a provider", async () => {
  const dependencies = { searchProvider: () => assert.fail("Provider must not be called") };
  for (const context of [
    { title: "" }, { title: "Example", type: "invalid" },
    { title: "Example", type: "show", season: 1 },
  ]) {
    await assert.rejects(findAuthorizedSources(context, dependencies), (error) => error.status === 400);
  }
});

test("shared search preserves episode and season packs and magnet fallback", async () => {
  const results = await findAuthorizedSources({ title: "Example", type: "show", season: 2, episode: 3 }, {
    searchProvider: async () => [
      candidate("Example S02E04", 50, "wrong"),
      candidate("Example S02E03", 20, "episode"),
      { ...candidate("Example S02 Complete", 10), source: { magnet } },
    ],
    inspectSource: async () => ({}),
  });
  assert.deepEqual(results.map((item) => item.title), ["Example S02E03", "Example S02 Complete"]);
  assert.deepEqual(results.map((item) => item.verification), ["verified", "magnet"]);
});

test("automatic playback tries ranked verified sources using server-side references", async () => {
  const started = [];
  const outcome = await startBestVerifiedSource({ title: "Sintel", type: "movie" }, {
    searchProvider: async () => [candidate("Sintel first", 20), candidate("Sintel second", 10, "second")],
    inspectSource: async () => ({}),
    startSource: async (source) => {
      started.push(source.releaseName);
      assert.equal(source.downloadUrl, "https://provider.test/torrent?apikey=secret");
      if (started.length === 1) throw new Error("Unavailable");
      return { id: "session" };
    },
  });
  assert.deepEqual(started, ["Sintel first", "Sintel second"]);
  assert.equal(outcome.session.id, "session");
});

test("unidentified pack stays visible but automatic next-episode start waits for manual mapping", async () => {
  const options = {
    searchProvider: async () => [candidate("Example S01 Complete")],
    inspectSource: async () => ({ manualSelectionRequired: true }),
    startSource: async () => assert.fail("Manual selection is required"),
  };
  const context = { title: "Example", type: "show", season: 1, episode: 1 };
  const results = await findAuthorizedSources(context, options);
  assert.equal(results[0].manualSelectionRequired, true);
  assert.equal(results[0].verification, "verified");
  assert.equal(await startBestVerifiedSource(context, options), null);
});

test("shared search preserves empty results and provider failure status", async () => {
  assert.deepEqual(await findAuthorizedSources({ title: "Nothing" }, { searchProvider: async () => [] }), []);
  await assert.rejects(findAuthorizedSources({ title: "Example" }, {
    searchProvider: async () => { throw Object.assign(new Error("Timed out"), { status: 504 }); },
  }), (error) => error.status === 504);
});

test("movie search uses English and original titles and deduplicates one torrent", async () => {
  const queries = [];
  const results = await findAuthorizedSources({ title: "Ugly", originalTitle: "Çirkin",
    type: "movie", tmdbId: 77 }, {
    searchProvider: async ({ title }) => {
      queries.push(title);
      return title === "Ugly"
        ? [candidate("Ugly 1080p", 20, "english"), candidate("Ugly alternate", 4, "shared")]
        : [candidate("Çirkin 1080p", 10, "original"), candidate("Çirkin duplicate", 2, "shared"),
          candidate("Other movie", 100, "shared")];
    },
    inspectSource: async () => ({}),
  });
  assert.deepEqual(queries, ["Ugly", "Çirkin"]);
  assert.deepEqual(results.map((result) => result.title),
    ["Ugly 1080p", "Çirkin 1080p", "Ugly alternate"]);
  assert.equal(results.every((result) => getSearchResult(result.id).mediaContext.tmdbId === 77), true);
});

test("both title languages retain space inside the 20-result validation limit", async () => {
  const results = await findAuthorizedSources({ title: "Ugly", originalTitle: "Çirkin", type: "movie" }, {
    searchProvider: async ({ title }) => title === "Ugly"
      ? Array.from({ length: 30 }, (_, index) => candidate(`Ugly ${index} 1080p`,
        100 - index, index.toString(16).padStart(40, "0")))
      : [candidate("Çirkin 1080p", 1, "original")],
    inspectSource: async () => ({}),
  });
  assert.equal(results.length, 20);
  assert.equal(results.some((result) => result.title === "Çirkin 1080p"), true);
});

test("identical titles search once, while one failed alias still allows the other", async () => {
  let calls = 0;
  await findAuthorizedSources({ title: "Ugly", originalTitle: " ugly ", type: "movie" }, {
    searchProvider: async () => { calls += 1; return [candidate("Ugly 1080p")]; },
    inspectSource: async () => ({}),
  });
  assert.equal(calls, 1);
  const results = await findAuthorizedSources({ title: "Ugly", originalTitle: "Çirkin", type: "movie" }, {
    searchProvider: async ({ title }) => {
      if (title === "Ugly") throw new Error("English lookup failed");
      return [candidate("Çirkin 720p")];
    },
    inspectSource: async () => ({}),
  });
  assert.deepEqual(results.map((result) => result.title), ["Çirkin 720p"]);
  await assert.rejects(findAuthorizedSources({ title: "Ugly", originalTitle: "Çirkin", type: "movie" }, {
    searchProvider: async () => { throw new Error("Search unavailable"); },
  }), /Search unavailable|No torrent search provider completed/);
});

test("non-Latin original titles match and TV searches stay single-title", async () => {
  const movie = await findAuthorizedSources({ title: "The Film", originalTitle: "映画", type: "movie" }, {
    searchProvider: async ({ title }) => title === "映画" ? [candidate("映画 1080p")] : [],
    inspectSource: async () => ({}),
  });
  assert.deepEqual(movie.map((result) => result.title), ["映画 1080p"]);
  let calls = 0;
  await findAuthorizedSources({ title: "Show", originalTitle: "番組", type: "show", season: 1, episode: 1 }, {
    searchProvider: async () => { calls += 1; return []; },
  });
  assert.equal(calls, 1);
});
