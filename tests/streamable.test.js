import assert from "node:assert/strict";
import test from "node:test";
import { saveSearchResult } from "../lib/search/result-store.js";
import { validateStreamableResults } from "../lib/search/streamable.js";

test("keeps only verified sources in seed-ranked order", async () => {
  const acceptedId = saveSearchResult({ downloadUrl: "https://indexer.test/accepted" });
  const rejectedId = saveSearchResult({ downloadUrl: "https://indexer.test/rejected" });
  const results = [
    { id: acceptedId, title: "Accepted", seeders: 10 },
    { id: rejectedId, title: "Rejected", seeders: 5 },
  ];

  const validated = await validateStreamableResults(
    results,
    { type: "movie" },
    async (source) => source.downloadUrl.endsWith("accepted") ? { playbackMode: "native" } : null,
  );

  assert.deepEqual(validated, [{
    id: acceptedId,
    title: "Accepted",
    seeders: 10,
    streamable: true,
    verification: "verified",
  }]);
});

test("validates no more than 20 candidates with four concurrent checks", async () => {
  const results = Array.from({ length: 25 }, (_, index) => ({
    id: saveSearchResult({ index, downloadUrl: `https://indexer.test/${index}` }),
    title: `Result ${index}`,
    seeders: 25 - index,
  }));
  let active = 0;
  let maximumActive = 0;
  let inspected = 0;

  const validated = await validateStreamableResults(results, {}, async () => {
    inspected += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { playbackMode: "native" };
  });

  assert.equal(inspected, 20);
  assert.equal(validated.length, 20);
  assert.equal(maximumActive, 4);
});

test("skips individual inspection failures", async () => {
  const firstId = saveSearchResult({ fail: true, downloadUrl: "https://indexer.test/broken" });
  const secondId = saveSearchResult({ fail: false, downloadUrl: "https://indexer.test/working" });
  const validated = await validateStreamableResults([
    { id: firstId, title: "Broken" },
    { id: secondId, title: "Working" },
  ], {}, async (source) => {
    if (source.fail) throw new Error("offline");
    return { playbackMode: "native" };
  });

  assert.deepEqual(validated.map((result) => result.title), ["Working"]);
});

test("shows verified sources before magnet sources and marks magnet fallback", async () => {
  const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
  const magnetOnlySource = { magnet };
  const failedDownloadSource = {
    downloadUrl: "https://indexer.test/unavailable",
    magnet,
  };
  const verifiedSource = { downloadUrl: "https://indexer.test/verified" };
  const magnetOnlyId = saveSearchResult(magnetOnlySource);
  const failedDownloadId = saveSearchResult(failedDownloadSource);
  const verifiedId = saveSearchResult(verifiedSource);
  const infoHash = "0123456789012345678901234567890123456789";

  const available = await validateStreamableResults([
    { id: magnetOnlyId, title: "Magnet only", seeders: 30, infoHash },
    { id: failedDownloadId, title: "Download failed", seeders: 20, infoHash },
    { id: verifiedId, title: "Verified", seeders: 10, infoHash: null },
  ], {}, async (source) => {
    if (source === failedDownloadSource) throw new Error("offline");
    return { playbackMode: "native" };
  });

  assert.deepEqual(
    available.map(({ title, streamable, verification }) => ({ title, streamable, verification })),
    [
      { title: "Verified", streamable: true, verification: "verified" },
      { title: "Magnet only", streamable: false, verification: "magnet" },
      { title: "Download failed", streamable: false, verification: "magnet" },
    ],
  );
  assert.equal(magnetOnlySource.preferMagnet, undefined);
  assert.equal(failedDownloadSource.preferMagnet, undefined);
});

test("hides sources whose parsed metadata proves incompatible", async () => {
  const source = {
    downloadUrl: "https://indexer.test/incompatible",
    magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
  };
  const id = saveSearchResult(source);
  const results = await validateStreamableResults([{
    id,
    title: "Incompatible",
    infoHash: "0123456789012345678901234567890123456789",
  }], {}, async () => null);

  assert.deepEqual(results, []);
  assert.equal(source.preferMagnet, undefined);
});
