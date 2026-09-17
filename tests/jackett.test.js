import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAndRankResults,
  JackettSearchError,
  parseIndexerIds,
  parseJackettXml,
  searchJackett,
  validateSearchQuery,
} from "../lib/search/jackett.js";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>Sintel 1080p</title>
      <size>1293942784</size>
      <link>https://indexer.test/download/one?apikey=download-secret</link>
      <jackettindexer id="public-domain">Public Domain Indexer</jackettindexer>
      <torznab:attr name="seeders" value="42" />
      <torznab:attr name="infohash" value="0123456789012345678901234567890123456789" />
      <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:0123456789012345678901234567890123456789&amp;dn=Sintel" />
    </item>
    <item>
      <title>Big Buck Bunny</title>
      <guid>magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd</guid>
      <enclosure url="https://indexer.test/download/two" type="application/x-bittorrent" />
      <jackettindexer id="open-media">Open Media</jackettindexer>
      <torznab:attr name="size" value="1000" />
    </item>
  </channel>
</rss>`;

const showXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>Public Domain Show S02E03 1080p</title>
      <size>2000</size>
      <guid>magnet:?xt=urn:btih:1111111111111111111111111111111111111111</guid>
      <torznab:attr name="seeders" value="3" />
      <torznab:attr name="infohash" value="1111111111111111111111111111111111111111" />
    </item>
    <item>
      <title>Public Domain Show Complete S02 720p</title>
      <size>4000</size>
      <guid>magnet:?xt=urn:btih:2222222222222222222222222222222222222222</guid>
      <torznab:attr name="seeders" value="8" />
      <torznab:attr name="infohash" value="2222222222222222222222222222222222222222" />
    </item>
  </channel>
</rss>`;

function withJackettEnvironment(run) {
  const previousUrl = process.env.JACKETT_URL;
  const previousKey = process.env.JACKETT_API_KEY;
  const previousMovieIndexers = process.env.JACKETT_MOVIE_INDEXERS;
  const previousShowIndexers = process.env.JACKETT_SHOW_INDEXERS;
  process.env.JACKETT_URL = "http://localhost:9117";
  process.env.JACKETT_API_KEY = "top-secret";
  process.env.JACKETT_MOVIE_INDEXERS = "movie-one,movie-two";
  process.env.JACKETT_SHOW_INDEXERS = "show-one,show-two";

  return Promise.resolve(run()).finally(() => {
    if (previousUrl === undefined) delete process.env.JACKETT_URL;
    else process.env.JACKETT_URL = previousUrl;
    if (previousKey === undefined) delete process.env.JACKETT_API_KEY;
    else process.env.JACKETT_API_KEY = previousKey;
    if (previousMovieIndexers === undefined) delete process.env.JACKETT_MOVIE_INDEXERS;
    else process.env.JACKETT_MOVIE_INDEXERS = previousMovieIndexers;
    if (previousShowIndexers === undefined) delete process.env.JACKETT_SHOW_INDEXERS;
    else process.env.JACKETT_SHOW_INDEXERS = previousShowIndexers;
  });
}

test("normalizes Jackett results without exposing download URLs", () => {
  const results = parseJackettXml(xml);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map(({ title, size, seeders, infoHash, indexer, canStart }) => ({
      title,
      size,
      seeders,
      infoHash,
      indexer,
      canStart,
    })),
    [
      {
        title: "Sintel 1080p",
        size: 1293942784,
        seeders: 42,
        infoHash: "0123456789012345678901234567890123456789",
        indexer: "Public Domain Indexer",
        canStart: true,
      },
      {
        title: "Big Buck Bunny",
        size: 1000,
        seeders: 0,
        infoHash: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        indexer: "Open Media",
        canStart: true,
      },
    ],
  );
  assert.equal(JSON.stringify(results).includes("download-secret"), false);
});

test("handles empty feeds and rejects malformed XML", () => {
  assert.deepEqual(parseJackettXml("<rss><channel /></rss>"), []);
  assert.throws(() => parseJackettXml("<rss><channel>"), /invalid XML/);
});

test("validates search queries with a 400 status", () => {
  assert.equal(validateSearchQuery("  sintel  "), "sintel");
  assert.throws(() => validateSearchQuery("   "), (error) => error.status === 400);
  assert.throws(() => validateSearchQuery("x".repeat(201)), (error) => error.status === 400);
});

test("uses the union of configured indexers for generic searches", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(new URL(url));
      return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
    };

    try {
      const results = await searchJackett("  sintel  ");
      assert.equal(requestedUrls.length, 4);
      assert.deepEqual(
        requestedUrls.map((url) => url.pathname),
        ["movie-one", "movie-two", "show-one", "show-two"].map(
          (id) => `/api/v2.0/indexers/${id}/results/torznab/api`,
        ),
      );
      assert.ok(requestedUrls.every((url) => url.origin === "http://localhost:9117"));
      assert.ok(requestedUrls.every((url) => url.searchParams.get("apikey") === "top-secret"));
      assert.ok(requestedUrls.every((url) => url.searchParams.get("t") === "search"));
      assert.ok(requestedUrls.every((url) => url.searchParams.get("q") === "sintel"));
      assert.equal(results.length, 2);
      assert.equal(JSON.stringify(results).includes("top-secret"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("parses, trims, and deduplicates indexer lists", () => {
  assert.deepEqual(
    parseIndexerIds(" yts, internetarchive,yts ", "JACKETT_MOVIE_INDEXERS"),
    ["yts", "internetarchive"],
  );
  assert.throws(
    () => parseIndexerIds("yts,../all", "JACKETT_MOVIE_INDEXERS"),
    (error) => error.status === 500 && error.message.includes("JACKETT_MOVIE_INDEXERS"),
  );
});

test("uses movie-specific Torznab search and category", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(new URL(url));
      return new Response(xml, { status: 200 });
    };

    try {
      await searchJackett("Sintel", { type: "movie" });
      assert.equal(requestedUrls.length, 2);
      assert.ok(requestedUrls.every((url) => url.pathname.includes("/indexers/movie-")));
      assert.ok(requestedUrls.every((url) => url.searchParams.get("t") === "movie"));
      assert.ok(requestedUrls.every((url) => url.searchParams.get("cat") === "2000"));
      assert.ok(requestedUrls.every((url) => url.searchParams.get("q") === "Sintel"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("queries individual and complete-season TV sources and removes duplicates", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(new URL(url));
      return new Response(showXml, { status: 200 });
    };

    try {
      const results = await searchJackett("Public Domain Show", {
        type: "show",
        season: 2,
        episode: 3,
      });
      assert.equal(requestedUrls.length, 4);
      assert.equal(requestedUrls[0].searchParams.get("t"), "tvsearch");
      assert.equal(requestedUrls[0].searchParams.get("cat"), "5000");
      assert.equal(requestedUrls[0].searchParams.get("season"), "2");
      assert.equal(requestedUrls[0].searchParams.get("ep"), "3");
      assert.equal(requestedUrls[1].searchParams.get("season"), "2");
      assert.equal(requestedUrls[1].searchParams.has("ep"), false);
      assert.equal(requestedUrls[2].searchParams.get("ep"), "3");
      assert.equal(requestedUrls[3].searchParams.has("ep"), false);
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((result) => result.seeders), [8, 3]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("filters unrelated shows and wrong episodes before sorting by seeders", () => {
  const results = filterAndRankResults([
    { title: "Devil in Disguise John Wayne Gacy S01E01 1080p HEVC", seeders: 5, size: 433 },
    { title: "Snoop Doggs Fatherhood Cori and Waynes Story S01E01 1080p", seeders: 50, size: 1800 },
    { title: "Devil in Disguise John Wayne Gacy S01E07 1080p HEVC", seeders: 25, size: 470 },
    { title: "The Devil in Disguise John Wayne Gacy S01E01 WEB h264", seeders: 14, size: 3400 },
    { title: "Devil in Disguise John Wayne Gacy Complete Season 1", seeders: 9, size: 5000 },
  ], {
    type: "show",
    query: "The Devil in Disguise: John Wayne Gacy",
    season: 1,
    episode: 1,
  });

  assert.deepEqual(results.map((result) => result.seeders), [14, 9, 5]);
  assert.ok(results.every((result) => result.title.includes("Devil in Disguise")));
  assert.equal(results.some((result) => result.title.includes("S01E07")), false);
});

test("accepts alternate episode notation and filters movie title mismatches", () => {
  const showResults = filterAndRankResults([
    { title: "Example Show 1x03 720p", seeders: 2, size: 100 },
    { title: "Example Show Season 1 Episode 3 1080p", seeders: 4, size: 200 },
  ], { type: "show", query: "Example Show", season: 1, episode: 3 });
  assert.deepEqual(showResults.map((result) => result.seeders), [4, 2]);

  const movieResults = filterAndRankResults([
    { title: "Sintel 2010 1080p", seeders: 3, size: 300 },
    { title: "Unrelated Sintel Documentary", seeders: 30, size: 200 },
    { title: "Sintel 2010 720p", seeders: 3, size: 100 },
  ], { type: "movie", query: "Sintel" });
  assert.deepEqual(movieResults.map((result) => result.title), [
    "Sintel 2010 720p",
    "Sintel 2010 1080p",
  ]);
});

test("validates show search context", async () => {
  await withJackettEnvironment(async () => {
    await assert.rejects(
      () => searchJackett("Example", { type: "show", season: 1 }),
      (error) => error.status === 400,
    );
  });
});

test("uses all configured Jackett indexers when a media list is empty", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    const requestedUrls = [];
    delete process.env.JACKETT_SHOW_INDEXERS;
    process.env.JACKETT_MOVIE_INDEXERS = "";
    globalThis.fetch = async (url) => {
      requestedUrls.push(new URL(url));
      return new Response(new URL(url).searchParams.get("t") === "movie" ? xml : showXml, {
        status: 200,
      });
    };

    try {
      await searchJackett("Sintel", { type: "movie" });
      await searchJackett("Public Domain Show", { type: "show", season: 2, episode: 3 });
      assert.equal(requestedUrls.length, 3);
      assert.ok(requestedUrls.every(
        (url) => url.pathname === "/api/v2.0/indexers/all/results/torznab/api",
      ));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("uses all configured indexers for generic searches when both lists are empty", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    let requestedUrl;
    process.env.JACKETT_MOVIE_INDEXERS = "";
    process.env.JACKETT_SHOW_INDEXERS = "";
    globalThis.fetch = async (url) => {
      requestedUrl = new URL(url);
      return new Response(xml, { status: 200 });
    };

    try {
      await searchJackett("Sintel");
      assert.equal(requestedUrl.pathname, "/api/v2.0/indexers/all/results/torznab/api");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("keeps successful results when another indexer fails", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (new URL(url).pathname.includes("movie-one")) throw new TypeError("offline");
      return new Response(xml, { status: 200 });
    };

    try {
      const results = await searchJackett("Sintel", { type: "movie" });
      assert.equal(results.length, 1);
      assert.equal(results[0].title, "Sintel 1080p");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("reports missing configuration without revealing partial secrets", async () => {
  const previousUrl = process.env.JACKETT_URL;
  const previousKey = process.env.JACKETT_API_KEY;
  delete process.env.JACKETT_URL;
  process.env.JACKETT_API_KEY = "do-not-leak";

  try {
    await assert.rejects(
      () => searchJackett("sintel"),
      (error) =>
        error instanceof JackettSearchError &&
        error.status === 500 &&
        !error.message.includes("do-not-leak"),
    );
  } finally {
    if (previousUrl === undefined) delete process.env.JACKETT_URL;
    else process.env.JACKETT_URL = previousUrl;
    if (previousKey === undefined) delete process.env.JACKETT_API_KEY;
    else process.env.JACKETT_API_KEY = previousKey;
  }
});

test("maps offline, timeout, and rejected Jackett requests to useful errors", async () => {
  await withJackettEnvironment(async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new TypeError("connection refused");
      };
      await assert.rejects(() => searchJackett("sintel"), (error) => error.status === 502);

      globalThis.fetch = async () => {
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      };
      await assert.rejects(() => searchJackett("sintel"), (error) => error.status === 504);

      globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
      await assert.rejects(
        () => searchJackett("sintel"),
        (error) => error.status === 502 && error.message.includes("JACKETT_API_KEY"),
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
