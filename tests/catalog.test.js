import assert from "node:assert/strict";
import test from "node:test";
import { catalogHref, interleaveByRank, mediaDetailsHref } from "../lib/metadata/catalog.js";
import { GET as searchRoute } from "../app/api/metadata/search/route.js";

test("builds canonical Search and Discover URLs with preserved state", () => {
  assert.equal(
    catalogHref("/search", { query: " alien ", type: "movie", genre: "horror", page: 2 }),
    "/search?q=alien&type=movie&genre=horror&page=2",
  );
  assert.equal(catalogHref("/discover", { type: "all", genre: "", page: 1 }), "/discover");
  assert.equal(catalogHref("/search", { query: "alien", type: "all", page: 1 }), "/search?q=alien");
});

test("routes normalized movie and TV results to existing detail pages", () => {
  assert.equal(mediaDetailsHref({ id: 10, mediaType: "movie" }), "/movies/10");
  assert.equal(mediaDetailsHref({ id: 20, mediaType: "tv" }), "/shows/20");
});

test("interleaves independent provider rankings", () => {
  assert.deepEqual(interleaveByRank(["m1", "m2"], ["t1", "t2", "t3"]), ["m1", "t1", "m2", "t2", "t3"]);
});

test("metadata Search API accepts an empty query and validates pagination", async () => {
  const emptyResponse = await searchRoute(new Request("http://localhost/api/metadata/search?q="));
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual((await emptyResponse.json()).results, []);

  const invalidResponse = await searchRoute(new Request("http://localhost/api/metadata/search?q=alien&page=0"));
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /Page must be/);
});
