import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { POST } from "../app/api/setup/route.js";

function setupRequest(providers) {
  return new Request("http://localhost:3000/api/setup", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ providers }),
  });
}

test("setup validates both candidates before saving and returns no credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-setup-"));
  const filename = path.join(directory, "torplay.env");
  const previous = {
    fetch: globalThis.fetch,
    configPath: process.env.TORPLAY_CONFIG_PATH,
    tmdb: process.env.TMDB_API_TOKEN,
    jackettUrl: process.env.JACKETT_URL,
    jackettKey: process.env.JACKETT_API_KEY,
    external: process.env.TORPLAY_EXTERNAL_CONFIG_KEYS,
  };
  process.env.TORPLAY_CONFIG_PATH = filename;
  delete process.env.TMDB_API_TOKEN;
  delete process.env.JACKETT_URL;
  delete process.env.JACKETT_API_KEY;
  delete process.env.TORPLAY_EXTERNAL_CONFIG_KEYS;
  try {
    globalThis.fetch = async (url) => String(url).includes("themoviedb")
      ? new Response("{}", { status: 401 })
      : new Response("<caps></caps>");
    const providers = {
      tmdb: { apiToken: "private-tmdb-token" },
      jackett: { url: "http://localhost:9117", apiKey: "private-jackett-key" },
    };
    const rejected = await POST(setupRequest(providers));
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 422);
    assert.equal(rejectedBody.ready, false);
    await assert.rejects(readFile(filename, "utf8"), { code: "ENOENT" });

    globalThis.fetch = async (url) => String(url).includes("localhost:9117")
      ? new Response("<caps></caps>")
      : new Response("{}");
    const accepted = await POST(setupRequest(providers));
    const acceptedText = await accepted.text();
    const acceptedBody = JSON.parse(acceptedText);
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.ready, true);
    assert.equal(acceptedText.includes("private-tmdb-token"), false);
    assert.equal(acceptedText.includes("private-jackett-key"), false);
    const source = await readFile(filename, "utf8");
    assert.match(source, /^TMDB_API_TOKEN=private-tmdb-token$/m);
    assert.match(source, /^JACKETT_API_KEY=private-jackett-key$/m);
    delete process.env.JACKETT_API_KEY;
    delete process.env.JACKETT_URL;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /themoviedb/);
      return new Response("{}");
    };
    const nativeSetup = await POST(setupRequest({ tmdb: {} }));
    assert.equal(nativeSetup.status, 200);
    assert.deepEqual((await nativeSetup.json()).results.map((item) => item.provider), ["tmdb"]);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ["TORPLAY_CONFIG_PATH", previous.configPath],
      ["TMDB_API_TOKEN", previous.tmdb],
      ["JACKETT_URL", previous.jackettUrl],
      ["JACKETT_API_KEY", previous.jackettKey],
      ["TORPLAY_EXTERNAL_CONFIG_KEYS", previous.external],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
