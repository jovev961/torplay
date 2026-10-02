import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { normalize, mediaContext } from "../lib/sources/contract.js";
import { rankCandidates } from "../lib/sources/relevance.js";
import { rememberTorrent, rememberNzb, resolve } from "../lib/sources/results.js";
import { hash, magnet, movie, episode, torznab } from "./helpers/sources-fixtures.js";

function candidate(title, overrides = {}) {
  return normalize({ title, locator: { magnet }, ...overrides }, torznab());
}

test("private IDs are distinct, opaque, expiring and kind-bound", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const id = rememberTorrent(candidate("Fixture"), {});
  const second = rememberTorrent(candidate("Fixture"), {});
  assert.notEqual(id, second);
  assert.match(id, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  assert.ok(!id.includes(hash));
  assert.equal(resolve(id, "torrent").magnet, magnet);
  assert.equal(resolve(id, "nzb"), null);
  assert.equal(resolve("unknown", "torrent"), null);
  assert.equal(resolve({ id }, "torrent"), null);
  now += 24 * 60 * 60_000;
  assert.equal(resolve(id, "torrent"), null);
});

test("private resolution validates magnets and binary torrent data", async () => {
  for (const invalid of [{ magnet: "magnet:?dn=fixture" }, { torrentInput: Buffer.from("not torrent data") },
    { torrentInput: "d4:infodee" }, { torrentInput: Buffer.alloc(6 * 1024 * 1024) }]) {
    const id = rememberTorrent(candidate("Fixture", { locator: { resolve: async () => invalid } }), {});
    await assert.rejects(resolve(id, "torrent").resolver(), { code: "INVALID_RESPONSE" });
  }
  const id = rememberTorrent(candidate("Fixture", { locator: { resolve: async () => ({ magnet }) } }), {});
  assert.equal((await resolve(id, "torrent").resolver()).infoHash, hash);
});

test("private resolver propagates cancellation into source work", async () => {
  const controller = new AbortController(); let aborted = false;
  const id = rememberTorrent(candidate("Fixture", { locator: { resolve: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    queueMicrotask(() => controller.abort());
  }) } }), {});
  await assert.rejects(resolve(id, "torrent").resolver({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(aborted, true);
});

test("valid binary torrent resolution returns only validated metadata", async () => {
  const info = "d6:lengthi10e4:name11:fixture.mkv12:piece lengthi16384e6:pieces20:01234567890123456789e";
  const torrentInput = Buffer.from(`d4:info${info}e`);
  const id = rememberTorrent(candidate("Fixture", { locator: { resolve: async () => ({ torrentInput, privateKey: "discard-fixture" }) } }), {});
  const resolved = await resolve(id, "torrent").resolver();
  assert.equal(resolved.infoHash, createHash("sha1").update(info).digest("hex"));
  assert.deepEqual(resolved.torrentInput, torrentInput);
  assert.equal(resolved.privateKey, undefined);
});

test("normalization rejects invalid locators and preserves missing optional metadata", () => {
  assert.equal(normalize({ title: "Fixture", locator: { downloadUrl: "file:///secret" } }, torznab()), null);
  assert.equal(normalize({ title: "Fixture", locator: { downloadUrl: "https://user:pass@fixture.example/a" } }, torznab()), null);
  assert.equal(normalize({ title: "Fixture", locator: { magnet: "magnet:?dn=fixture" } }, torznab()), null);
  const valid = candidate("The Tailor");
  assert.equal(valid.size, null); assert.equal(valid.seeders, null);
  assert.equal(rankCandidates([valid], mediaContext(movie)).length, 1);
});

test("NZB IDs retain server-only indexer identity and reject unsafe locators", () => {
  const id = rememberNzb({ indexerId: "personal", title: "Fixture", nzbUrl: "https://personal.example/get?apikey=private-key" }, {});
  assert.equal(resolve(id, "torrent"), null);
  assert.equal(resolve(id, "nzb").indexerId, "personal");
  assert.ok(resolve(id, "nzb").nzbUrl.includes("private-key"));
  assert.throws(() => rememberNzb({ indexerId: "personal", nzbUrl: "file:///secret" }, {}));
  assert.throws(() => rememberNzb({ nzbUrl: "https://personal.example/get" }, {}));
});

for (const [label, context, titles, expected] of [
  ["similar-prefix rejection", movie, ["The Tailor of Sin City 2023", "The Tailor 2023 1080p"], ["The Tailor 2023 1080p"]],
  ["punctuation and case", { title: "A Boy's Life", type: "movie" }, ["A.BOYS.LIFE.1080p.WEB-DL", "A Boys Life Story"], ["A.BOYS.LIFE.1080p.WEB-DL"]],
  ["international original title", { title: "The Tailor", originalTitle: "Терзија", type: "movie" }, ["Терзија 1080p", "Друг филм 1080p"], ["Терзија 1080p"]],
  ["accent normalization", { title: "Amélie", type: "movie" }, ["Amelie 2001 1080p", "Amelia 1080p"], ["Amelie 2001 1080p"]],
  ["movie release year", movie, ["The Tailor 2021 1080p", "The Tailor 2023 1080p"], ["The Tailor 2023 1080p"]],
  ["episode and pack eligibility", episode, ["The Tailor S02E04", "The Tailor S01", "The Tailor S02", "The Tailor S02E03"], ["The Tailor S02E03", "The Tailor S02"]],
  ["multi-episode release", episode, ["The Tailor S02E03E04", "The Tailor S02E05E06"], ["The Tailor S02E03E04"]],
]) {
  test(`provider-neutral relevance: ${label}`, () => {
    const items = titles.map((title, index) => candidate(title, { infoHash: index.toString(16).padStart(40, "0"), locator: {} }));
    assert.deepEqual(rankCandidates(items, mediaContext(context)).map((c) => c.title), expected);
  });
}

test("matching media identity admits alternate names and contradictions reject candidates", () => {
  const context = mediaContext({ ...movie, imdbId: "tt1234567" });
  assert.equal(rankCandidates([candidate("Terzi", { media: { imdbId: "tt1234567" } })], context).length, 1);
  assert.equal(rankCandidates([candidate("The Tailor", { media: { imdbId: "tt9999999" } })], context).length, 0);
  assert.equal(rankCandidates([candidate("The Tailor", { media: { type: "show" } })], context).length, 0);
  assert.equal(rankCandidates([candidate("The Tailor S02E03", { media: { season: 1 } })], mediaContext(episode)).length, 0);
});

for (const title of ["The Tailor S02E03E04E05", "The.Tailor.S02E03E04E05.1080p.WEB-DL",
  "The Tailor S02E03E05E07E09"]) {
  const listed = title.includes("E09") ? [3, 5, 7, 9] : [3, 4, 5];
  for (const requested of listed) {
    test(`explicit episode list accepts episode ${requested}: ${title}`, () => {
      const release = candidate(title);
      assert.deepEqual(rankCandidates([release], mediaContext({ ...episode, episode: requested })), [release]);
    });
  }
  test(`explicit episode list rejects absent episodes and wrong seasons: ${title}`, () => {
    const release = candidate(title);
    for (const requested of [2, 6, 10]) {
      assert.deepEqual(rankCandidates([release], mediaContext({ ...episode, episode: requested })), []);
    }
    assert.deepEqual(rankCandidates([release], mediaContext({ ...episode, season: 1, episode: 5 })), []);
  });
}

test("deduplication and rank are deterministic across input completion order", () => {
  const a = candidate("The Tailor 2023", { seeders: 4 });
  const b = { ...a, sourceId: "second", seeders: 10 };
  const c = candidate("The Tailor 2023 720p", { infoHash: "f".repeat(40), locator: {}, seeders: 3 });
  const context = mediaContext(movie);
  assert.deepEqual(rankCandidates([a, b, c], context), rankCandidates([c, b, a], context));
  assert.equal(rankCandidates([a, b, c], context).length, 2);
  assert.equal(rankCandidates([a, b, c], context)[0].sourceId, "second");
});

test("two NZBs from separate indexers do not collide with torrent candidates", () => {
  const nzb = { title: "The Tailor 2023", kind: "nzb", indexerId: "one", guid: "shared", size: null };
  assert.equal(rankCandidates([nzb, { ...nzb, indexerId: "two" }, candidate("The Tailor 2023")], mediaContext(movie)).length, 3);
});
