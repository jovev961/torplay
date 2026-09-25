import assert from "node:assert/strict";
import test from "node:test";
import {
  commitNextEpisodeContext,
  findNextEpisode,
  findPreviousEpisode,
  resolveNextEpisodePlayback,
} from "../lib/playback/next-episode.js";

function tmdbResponse(value) {
  return new Response(JSON.stringify(value), { status: 200 });
}

async function withMetadata(responses, run) {
  const previousToken = process.env.TMDB_API_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.TMDB_API_TOKEN = "test-token";
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    const value = responses[pathname];
    if (!value) throw new Error(`Unexpected metadata request: ${pathname}`);
    return tmdbResponse(value);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
}

const episode = (number, name = `Episode ${number}`) => ({ episode_number: number, name, overview: "" });

test("metadata resolves a normal next episode", async () => {
  await withMetadata({
    "/3/tv/100/season/1": { season_number: 1, name: "Season 1", episodes: [episode(1), episode(2)] },
  }, async () => {
    const next = await findNextEpisode(100, 1, 1);
    assert.equal(next.season, 1);
    assert.equal(next.number, 2);
  });
});

test("metadata crosses a season boundary without inventing an episode", async () => {
  await withMetadata({
    "/3/tv/101/season/1": { season_number: 1, name: "Season 1", episodes: [episode(8)] },
    "/3/tv/101": {
      id: 101,
      name: "Show",
      seasons: [
        { season_number: 1, name: "Season 1", episode_count: 8 },
        { season_number: 2, name: "Season 2", episode_count: 6 },
      ],
      genres: [],
    },
    "/3/tv/101/season/2": { season_number: 2, name: "Season 2", episodes: [episode(1)] },
  }, async () => {
    const next = await findNextEpisode(101, 1, 8);
    assert.deepEqual({ season: next.season, number: next.number }, { season: 2, number: 1 });
  });
});

test("metadata returns no next episode at the end of a series", async () => {
  await withMetadata({
    "/3/tv/102/season/2": { season_number: 2, name: "Season 2", episodes: [episode(6)] },
    "/3/tv/102": { id: 102, name: "Show", seasons: [{ season_number: 2, name: "Season 2", episode_count: 6 }], genres: [] },
  }, async () => assert.equal(await findNextEpisode(102, 2, 6), null));
});

test("metadata resolves previous episodes across a season boundary", async () => {
  await withMetadata({
    "/3/tv/103/season/2": { season_number: 2, name: "Season 2", episodes: [episode(1), episode(2)] },
    "/3/tv/103": { id: 103, name: "Show", seasons: [
      { season_number: 1, name: "Season 1", episode_count: 2 },
      { season_number: 2, name: "Season 2", episode_count: 2 },
    ], genres: [] },
    "/3/tv/103/season/1": { season_number: 1, name: "Season 1", episodes: [episode(1), episode(2)] },
  }, async () => {
    assert.deepEqual({ season: (await findPreviousEpisode(103, 2, 2)).season,
      number: (await findPreviousEpisode(103, 2, 2)).number }, { season: 2, number: 1 });
    const previous = await findPreviousEpisode(103, 2, 1);
    assert.deepEqual({ season: previous.season, number: previous.number }, { season: 1, number: 2 });
  });
});

test("previous episode skips specials and stops at the first regular episode", async () => {
  await withMetadata({
    "/3/tv/104/season/1": { season_number: 1, name: "Season 1", episodes: [episode(1)] },
    "/3/tv/104": { id: 104, name: "Show", seasons: [
      { season_number: 0, name: "Specials", episode_count: 1 },
      { season_number: 1, name: "Season 1", episode_count: 1 },
    ], genres: [] },
  }, async () => assert.equal(await findPreviousEpisode(104, 1, 1), null));
});

function dependencies(overrides = {}) {
  return {
    getMediaContext: () => ({ type: "show", tmdbId: 200, title: "Show", season: 1, episode: 4 }),
    nextEpisode: async () => ({ season: 1, number: 5, title: "Next" }),
    findSessionEpisode: () => null,
    resolveDirectDebrid: async () => ({ kind: "miss" }),
    startBestSource: async () => null,
    ...overrides,
  };
}

test("next episode reuses the current season or multi-season torrent before searching", async () => {
  let searched = false;
  for (const nextEpisode of [{ season: 1, number: 5 }, { season: 2, number: 1 }]) {
    const result = await resolveNextEpisodePlayback("session-1", dependencies({
      nextEpisode: async () => ({ ...nextEpisode, title: "Next" }),
      findSessionEpisode: (id, season, number) => ({
        session: { id },
        file: { id: `${season}-${number}` },
      }),
      startBestSource: async () => { searched = true; return null; },
    }));
    assert.equal(result.strategy, "reuse");
    assert.equal(result.fileId, `${nextEpisode.season}-${nextEpisode.number}`);
  }
  assert.equal(searched, false);
});

test("next episode does not switch to another ready debrid item", async () => {
  let switched = false;
  const result = await resolveNextEpisodePlayback("session-1", dependencies({
    resolveDirectDebrid: async () => { switched = true; return { kind: "hit" }; },
    startBestSource: async () => { switched = true; return null; },
  }));
  assert.equal(result.status, "manual-required");
  assert.equal(result.strategy, "search");
  assert.equal(switched, false);
});

test("reused torrent context advances only when playback is committed", () => {
  const current = { type: "show", tmdbId: 200, title: "Show", season: 1, episode: 4 };
  let updated = null;
  const result = commitNextEpisodeContext("session-1", { season: 1, episode: 5 }, {
    getMediaContext: () => current,
    updateMediaContext: (_id, context) => { updated = context; return true; },
  });
  assert.deepEqual([result.season, result.episode], [1, 5]);
  assert.deepEqual([updated.season, updated.episode], [1, 5]);
});

test("missing current-torrent episode asks the viewer to choose a source", async () => {
  let searched = false;
  const result = await resolveNextEpisodePlayback("session-1", dependencies({
    startBestSource: async () => { searched = true; return { session: { id: "session-2" } }; },
  }));
  assert.equal(result.strategy, "search");
  assert.equal(result.status, "manual-required");
  assert.equal(searched, false);
});

test("missing current-torrent episode explains why manual selection is needed", async () => {
  const missing = await resolveNextEpisodePlayback("session-1", dependencies());
  assert.equal(missing.status, "manual-required");
  assert.match(missing.error, /selected torrent does not contain/);
});

test("no metadata-confirmed next episode stops cleanly", async () => {
  const result = await resolveNextEpisodePlayback("session-1", dependencies({ nextEpisode: async () => null }));
  assert.deepEqual(result, { status: "end-of-series", nextEpisode: null });
});

test("previous and selected episode resolution reuse only a matching file", async () => {
  const previous = await resolveNextEpisodePlayback("session-1", dependencies({
    previousEpisode: async () => ({ season: 1, number: 3, title: "Previous" }),
    findSessionEpisode: (_id, season, number) => ({ session: { id: "session-1" },
      file: { id: `${season}-${number}` } }),
  }), "previous");
  assert.equal(previous.fileId, "1-3");
  const selected = await resolveNextEpisodePlayback("session-1", dependencies({
    selectedEpisode: async (_showId, target) => ({ season: target.season,
      number: target.episode, title: "Selected" }),
    findSessionEpisode: () => null,
  }), "selected", { season: 4, episode: 2 });
  assert.equal(selected.status, "manual-required");
  assert.deepEqual([selected.nextEpisode.season, selected.nextEpisode.number], [4, 2]);
});

test("selected episode must be confirmed by metadata and direction is validated", async () => {
  await withMetadata({
    "/3/tv/200/season/1": { season_number: 1, name: "Season 1", episodes: [episode(1)] },
  }, async () => {
    const absent = await resolveNextEpisodePlayback("session-1", dependencies(),
      "selected", { season: 1, episode: 9 });
    assert.deepEqual(absent, { status: "end-of-series", nextEpisode: null });
  });
  await assert.rejects(resolveNextEpisodePlayback("session-1", dependencies(), "skip"),
    (error) => error.status === 400);
});
