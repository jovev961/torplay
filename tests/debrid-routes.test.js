import assert from "node:assert/strict";
import test from "node:test";
import { GET as streamGet } from "../app/api/torrents/[id]/files/[fileId]/stream/route.js";
import { POST as providerPost } from "../app/api/settings/debrid/[provider]/route.js";

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
