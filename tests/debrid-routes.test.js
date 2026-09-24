import assert from "node:assert/strict";
import test from "node:test";
import { GET as streamGet } from "../app/api/torrents/[id]/files/[fileId]/stream/route.js";
import { POST as providerPost } from "../app/api/settings/debrid/[provider]/route.js";
import { GET as libraryGet } from "../app/api/debrid/library/route.js";
import { DELETE as libraryDelete } from "../app/api/debrid/library/[provider]/[id]/route.js";
import { POST as libraryPlay } from "../app/api/debrid/library/[provider]/[id]/play/route.js";
import { POST as associationPost } from "../app/api/debrid/library/[provider]/[id]/association/route.js";
import { POST as directPlay } from "../app/api/playback/debrid/route.js";
import { POST as torrentStart } from "../app/api/torrents/route.js";

test("unknown playback sessions cannot proxy remote media", async () => {
  const response = await streamGet(
    new Request("http://localhost/api/torrents/unknown/files/0/stream"),
    { params: Promise.resolve({ id: "unknown", fileId: "0" }) },
  );
  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(await response.json()).includes("https://"), false);
});

test("debrid credential actions reject untrusted and cross-origin requests", async () => {
  const untrusted = await providerPost(new Request("https://public.example/api/settings/debrid/torbox", {
    method: "POST", headers: {
      host: "public.example", origin: "https://public.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "key", apiKey: "never-store-me" }),
  }), { params: Promise.resolve({ provider: "torbox" }) });
  assert.equal(untrusted.status, 403);
  assert.equal((await untrusted.text()).includes("never-store-me"), false);
  const foreignOrigin = await providerPost(new Request("http://localhost/api/settings/debrid/torbox", {
    method: "POST", headers: {
      host: "localhost", origin: "https://attacker.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "key", apiKey: "never-store-me" }),
  }), { params: Promise.resolve({ provider: "torbox" }) });
  assert.equal(foreignOrigin.status, 403);
});

test("malformed key requests do not echo credential text", async () => {
  const response = await providerPost(new Request("http://localhost/api/settings/debrid/real-debrid", {
    method: "POST", headers: {
      host: "localhost", origin: "http://localhost",
      "content-type": "application/json",
    },
    body: '{"action":"key","apiKey":"private-token" broken',
  }), { params: Promise.resolve({ provider: "real-debrid" }) });
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes("private-token"), false);
});

test("library account data and destructive actions reject public or foreign origins", async () => {
  const publicList = await libraryGet(new Request("https://public.example/api/debrid/library", {
    headers: { host: "public.example" },
  }));
  assert.equal(publicList.status, 403);
  const params = { params: Promise.resolve({ provider: "torbox", id: "7" }) };
  const foreignDelete = await libraryDelete(new Request("http://localhost/api/debrid/library/torbox/7", {
    method: "DELETE", headers: { host: "localhost", origin: "https://attacker.example" },
  }), params);
  assert.equal(foreignDelete.status, 403);
  const foreignPlay = await libraryPlay(new Request("http://localhost/api/debrid/library/torbox/7/play", {
    method: "POST", headers: { host: "localhost", origin: "https://attacker.example",
      "content-type": "application/json" }, body: JSON.stringify({ fileId: "1" }),
  }), params);
  assert.equal(foreignPlay.status, 403);
  const foreignStart = await torrentStart(new Request("http://localhost/api/torrents", {
    method: "POST", headers: { host: "localhost", origin: "https://attacker.example",
      "content-type": "application/json" }, body: JSON.stringify({ resultId: "none" }),
  }));
  assert.equal(foreignStart.status, 403);
  const foreignAssociation = await associationPost(new Request("http://localhost/api/debrid/library/torbox/7/association", {
    method: "POST", headers: { host: "localhost", origin: "https://attacker.example",
      "content-type": "application/json" }, body: JSON.stringify({ type: "show", tmdbId: 1, season: 1 }),
  }), params);
  assert.equal(foreignAssociation.status, 403);
  const foreignDirectPlay = await directPlay(new Request("http://localhost/api/playback/debrid", {
    method: "POST", headers: { host: "localhost", origin: "https://attacker.example",
      "content-type": "application/json" }, body: JSON.stringify({ type: "show", tmdbId: 1, season: 1, episode: 2 }),
  }));
  assert.equal(foreignDirectPlay.status, 403);
});
