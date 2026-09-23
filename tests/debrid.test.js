import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDebridConfig, updateDebridConfig, updateDebridPolicy, publicDebridConfig } from "../lib/debrid/config.js";
import {
  RealDebridProvider, finishRealDebridAuthorization, startRealDebridAuthorization,
} from "../lib/debrid/real-debrid.js";
import {
  TorBoxProvider, finishTorBoxAuthorization, startTorBoxAuthorization,
} from "../lib/debrid/torbox.js";
import { providerRequest } from "../lib/debrid/http.js";
import { DebridError } from "../lib/debrid/http.js";
import { connectDebridApiKey, disconnectDebrid } from "../lib/debrid/auth.js";
import { getPlaybackSession, makeDebridProvider, startPlaybackSource, stopPlayback } from "../lib/debrid/session.js";
import { findEpisodeFile, findLargestFile } from "../lib/video/episode.js";

const hash = "a".repeat(40);
const magnet = `magnet:?xt=urn:btih:${hash}`;
const context = { type: "show", title: "Show", season: 1, episode: 3 };
const episodeFiles = [1, 2, 3, 4].map((number) => ({
  providerId: String(number), name: `Show.S01E0${number}.mkv`,
  path: `Show.S01/Show.S01E0${number}.mkv`, size: 1_000_000,
}));
function response(data, status = 200) {
  return Response.json(data, { status });
}

test("debrid policy defaults to local and redacts credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-debrid-"));
  const filename = path.join(directory, "debrid-config.json");
  try {
    assert.equal((await readDebridConfig({ path: filename })).mode, "local");
    await updateDebridPolicy({
      mode: "prefer-debrid", priority: ["torbox", "real-debrid"], localFallback: false,
    }, { path: filename });
    const config = await readDebridConfig({ path: filename });
    assert.deepEqual(config.priority, ["torbox", "real-debrid"]);
    assert.equal(publicDebridConfig({
      ...config, credentials: { torbox: { apiKey: "secret-token" } },
    }).providers.torbox.configured, true);
    assert.equal(JSON.stringify(publicDebridConfig(config)).includes("secret-token"), false);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(filename, "utf8")).localFallback, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Real-Debrid reuses only a completed account torrent and validates the exact file link", async () => {
  const calls = [];
  const provider = new RealDebridProvider({
    accessToken: "access", refreshToken: "refresh", clientId: "client",
    clientSecret: "client-secret", expiresAt: Date.now() + 60_000,
  }, {
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname;
      calls.push(route);
      assert.equal(options.headers.get("authorization"), "Bearer access");
      if (route.endsWith("/torrents")) return response([{ id: "existing", hash, status: "downloaded" }]);
      if (route.endsWith("/torrents/info/existing")) return response({
        files: episodeFiles.map((file, index) => ({
          id: index + 1, path: `/${file.path}`, bytes: file.size, selected: 1,
        })), links: ["https://host.invalid/one", "https://host.invalid/three"],
      });
      if (route.endsWith("/unrestrict/link")) {
        const link = new URLSearchParams(options.body).get("link");
        return response(link?.endsWith("/three")
          ? { filename: "Show.S01E03.mkv", filesize: 1_000_000, download: "https://cdn.example/video" }
          : { filename: "Show.S01E01.mkv", filesize: 1_000_000, download: "https://cdn.example/one" });
      }
      throw new Error(`Unexpected route ${route}`);
    },
  });
  const availability = await provider.checkAvailability({ infoHash: hash });
  assert.equal(availability.status, "available");
  const selected = findEpisodeFile(availability.files.map((file) => ({
    ...file, relativePath: file.path,
  })), 1, 3);
  assert.equal(selected.providerId, "3");
  const stream = await provider.resolveStream({}, selected, availability);
  assert.equal(stream.url, "https://cdn.example/video");
  assert.equal(stream.resource.owned, false);
  assert.equal(calls.some((route) => route.includes("addMagnet") || route.includes("selectFiles")), false);
});

test("Real-Debrid refreshes expired OAuth credentials before account lookup", async () => {
  const calls = [];
  let saved = null;
  const provider = new RealDebridProvider({
    accessToken: "old", refreshToken: "refresh", clientId: "client",
    clientSecret: "secret", expiresAt: 0,
  }, {
    fetchImpl: async (url, options) => {
      calls.push(new URL(url).pathname);
      if (new URL(url).pathname.endsWith("/token")) return response({
        access_token: "new", refresh_token: "new-refresh", expires_in: 3600,
      });
      assert.equal(options.headers.get("authorization"), "Bearer new");
      return response({ id: 123 });
    },
    onRefresh: async (next) => { saved = next; },
  });
  assert.equal((await provider.getAccountInfo()).id, 123);
  assert.equal(saved.refreshToken, "new-refresh");
  assert.equal(calls.length, 2);
});

test("Real-Debrid manual token uses bearer authentication without OAuth refresh or revocation", async () => {
  const calls = [];
  const provider = new RealDebridProvider({ apiKey: "private-token" }, {
    fetchImpl: async (url, options) => {
      calls.push(new URL(url).pathname);
      assert.equal(options.headers.get("authorization"), "Bearer private-token");
      return response({ id: 123 });
    },
  });
  assert.equal((await provider.getAccountInfo()).id, 123);
  await provider.disconnect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endsWith("/user"), true);
});

test("manual keys validate before replacing credentials and stay redacted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-debrid-keys-"));
  const configOptions = { path: path.join(directory, "debrid-config.json") };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    const token = options.headers.get("authorization");
    calls.push({ route, token });
    if (token === "Bearer invalid-key") return response({ error: "bad key" }, 401);
    if (route.endsWith("/user")) {
      assert.equal(token, "Bearer real-debrid-key");
      return response({ id: 1 });
    }
    assert.equal(route.endsWith("/user/me"), true);
    assert.equal(token, "Bearer torbox-key");
    return response({ success: true, data: { id: 2 } });
  };
  try {
    await connectDebridApiKey("real-debrid", "real-debrid-key", fetchImpl, configOptions);
    await connectDebridApiKey("torbox", "torbox-key", fetchImpl, configOptions);
    await assert.rejects(
      connectDebridApiKey("real-debrid", "invalid-key", fetchImpl, configOptions),
      (error) => error.status === 400 && !error.message.includes("invalid-key"),
    );
    const config = await readDebridConfig(configOptions);
    assert.equal(config.credentials["real-debrid"].apiKey, "real-debrid-key");
    assert.equal(config.credentials.torbox.apiKey, "torbox-key");
    assert.equal(JSON.stringify(publicDebridConfig(config)).includes("-key"), false);
    assert.equal(calls.length, 3);
    await disconnectDebrid("real-debrid", configOptions);
    assert.equal((await readDebridConfig(configOptions)).credentials["real-debrid"], undefined);
    assert.equal(calls.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old OAuth refresh cannot replace a newly saved manual token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-debrid-refresh-"));
  const configOptions = { path: path.join(directory, "debrid-config.json") };
  const old = {
    clientId: "client", clientSecret: "secret", accessToken: "old",
    refreshToken: "old-refresh", expiresAt: 0,
  };
  try {
    await updateDebridConfig((config) => ({
      ...config, credentials: { "real-debrid": old },
    }), configOptions);
    const provider = makeDebridProvider("real-debrid", old, {
      configOptions,
      fetchImpl: async () => response({
        access_token: "new", refresh_token: "new-refresh", expires_in: 3600,
      }),
    });
    await updateDebridConfig((config) => ({
      ...config, credentials: { "real-debrid": { apiKey: "manual-token" } },
    }), configOptions);
    await provider.refresh();
    assert.equal((await readDebridConfig(configOptions)).credentials["real-debrid"].apiKey,
      "manual-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Real-Debrid open-source device authorization obtains user-bound credentials", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname.endsWith("/device/code")) {
      assert.equal(parsed.searchParams.get("new_credentials"), "yes");
      return response({
        device_code: "device", user_code: "CODE", interval: 5,
        expires_in: 600, verification_url: "https://real-debrid.com/device",
      });
    }
    if (parsed.pathname.endsWith("/device/credentials")) {
      return response({ client_id: "user-client", client_secret: "user-secret" });
    }
    assert.equal(new URLSearchParams(options.body).get("client_id"), "user-client");
    return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  };
  assert.equal((await startRealDebridAuthorization(fetchImpl)).user_code, "CODE");
  const credentials = await finishRealDebridAuthorization("device", fetchImpl);
  assert.equal(credentials.clientId, "user-client");
  assert.equal(credentials.refreshToken, "refresh");
  assert.equal(calls.length, 3);
});

test("TorBox checks cache, creates cached-only, and resolves one requested file", async () => {
  const calls = [];
  const provider = new TorBoxProvider({ apiKey: "private-token" }, {
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      const route = requestUrl.pathname;
      calls.push(route);
      if (route.endsWith("/checkcached")) return response({
        success: true, data: { [hash]: { files: episodeFiles.map((file, index) => ({
          id: index + 1, name: file.path, size: file.size,
        })) } },
      });
      if (route.endsWith("/mylist") && !requestUrl.searchParams.has("id")) {
        return response({ success: true, data: [] });
      }
      if (route.endsWith("/createtorrent")) {
        assert.equal(options.body.get("add_only_if_cached"), "true");
        assert.equal(options.body.get("magnet"), magnet);
        return response({ success: true, data: { torrent_id: 7 } });
      }
      if (route.endsWith("/mylist")) return response({
        success: true, data: {
          id: 7, download_present: true, download_finished: true,
          files: episodeFiles.map((file, index) => ({
            id: index + 10, name: file.path, size: file.size,
          })),
        },
      });
      if (route.endsWith("/requestdl")) {
        assert.equal(requestUrl.searchParams.get("token"), "private-token");
        assert.equal(requestUrl.searchParams.get("file_id"), "12");
        return response({ success: true, data: "https://cdn.example/episode-3" });
      }
      throw new Error(`Unexpected route ${route}`);
    },
  });
  const availability = await provider.checkAvailability({ infoHash: hash });
  assert.equal(availability.status, "available");
  const selected = findEpisodeFile(availability.files.map((file) => ({
    ...file, relativePath: file.path,
  })), 1, 3);
  const stream = await provider.resolveStream({ infoHash: hash, magnet }, selected);
  assert.equal(stream.url, "https://cdn.example/episode-3");
  assert.equal(stream.resource.owned, true);
  assert.equal(calls.filter((route) => route.endsWith("/createtorrent")).length, 1);
});

test("TorBox device authorization receives a server-only API key", async () => {
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/device/start")) {
      assert.equal(parsed.searchParams.get("app"), "TorPlay");
      return response({ success: true, data: {
        device_code: "device", code: "123456",
        verification_url: "https://torbox.app/device", interval: 5,
      } });
    }
    assert.equal(JSON.parse(options.body).device_code, "device");
    return response({ success: true, data: { access_token: "torbox-private-key" } });
  };
  assert.equal((await startTorBoxAuthorization(fetchImpl)).code, "123456");
  assert.equal(await finishTorBoxAuthorization("device", fetchImpl), "torbox-private-key");
});

test("provider HTTP failures distinguish rate limits, timeouts, and malformed responses", async () => {
  await assert.rejects(providerRequest("https://api.example/", "check", {
    fetchImpl: async () => new Response(null, {
      status: 429, headers: { "Retry-After": "10" },
    }),
  }), (error) => error.code === "rate-limited" && error.retryAfter === "10");
  await assert.rejects(providerRequest("https://api.example/", "check", {
    fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); },
  }), (error) => error.code === "timeout");
  await assert.rejects(providerRequest("https://api.example/", "check", {
    fetchImpl: async () => new Response("<html>not JSON</html>"),
  }), (error) => error.code === "malformed-response");
});

test("resolver preserves backend order, requested episode, and local fallback policy", async () => {
  const source = { magnet, mediaContext: context, releaseName: "Show.S01" };
  const events = [];
  const providers = {
    "real-debrid": {
      id: "real-debrid",
      async checkAvailability() { events.push("rd-check"); return { status: "miss" }; },
    },
    torbox: {
      id: "torbox",
      async checkAvailability() {
        events.push("tb-check");
        return { status: "available", files: episodeFiles };
      },
      async resolveStream(_torrent, selection) {
        events.push(`tb-file-${selection.providerId}`);
        return { url: "https://cdn.example/episode-3", resource: { id: 8, owned: false } };
      },
      async cleanup() {},
    },
  };
  const config = {
    mode: "prefer-debrid", priority: ["real-debrid", "torbox"], localFallback: true,
    credentials: { "real-debrid": {}, torbox: {} },
  };
  const session = await startPlaybackSource(source, {
    config, providerFactory: (id) => providers[id], probe: async () => {},
  });
  assert.deepEqual(events, ["rd-check", "tb-check", "tb-file-3"]);
  assert.equal(session.backend, "debrid");
  assert.equal(session.provider, "torbox");
  assert.equal(getPlaybackSession(session.id).files.length, 4);
  await stopPlayback(session.id);

  const local = await startPlaybackSource(source, {
    config: { ...config, credentials: {} },
    startLocal: async () => ({ id: "local-test", status: "loading" }),
  });
  assert.equal(local.id, "local-test");
  await assert.rejects(startPlaybackSource(source, {
    config: { ...config, mode: "debrid-only", credentials: {} },
    startLocal: async () => { throw new Error("Must not run"); },
  }), /No debrid provider/);
  const only = await startPlaybackSource(source, {
    config: { ...config, mode: "local" },
    startLocal: async () => ({ id: "local-only" }),
    providerFactory: () => { throw new Error("Must not run"); },
  });
  assert.equal(only.id, "local-only");
});

test("resolver continues after an unavailable provider and obeys reversed priority", async () => {
  const events = [];
  const providers = {
    torbox: {
      id: "torbox",
      async checkAvailability() { events.push("torbox"); throw new DebridError("unavailable", "Unavailable"); },
    },
    "real-debrid": {
      id: "real-debrid",
      async checkAvailability() {
        events.push("real-debrid");
        return { status: "available", files: [episodeFiles[2]] };
      },
      async resolveStream() {
        return { url: "https://cdn.example/episode-3", resource: { id: "ready", owned: false } };
      },
    },
  };
  const session = await startPlaybackSource({
    magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
    mediaContext: context,
  }, {
    config: {
      mode: "prefer-debrid", priority: ["torbox", "real-debrid"], localFallback: true,
      credentials: { torbox: { apiKey: "unavailable-key" }, "real-debrid": { accessToken: "ready-token" } },
    },
    providerFactory: (id) => providers[id], probe: async () => {},
  });
  assert.deepEqual(events, ["torbox", "real-debrid"]);
  assert.equal(session.provider, "real-debrid");
  await stopPlayback(session.id);
});

test("two cache misses use local fallback, while Debrid Only rejects without WebTorrent", async () => {
  const source = {
    magnet: `magnet:?xt=urn:btih:${"c".repeat(40)}`, mediaContext: context,
  };
  const calls = [];
  const config = {
    mode: "prefer-debrid", priority: ["real-debrid", "torbox"], localFallback: true,
    credentials: { "real-debrid": { accessToken: "miss-rd" }, torbox: { apiKey: "miss-tb" } },
  };
  const providerFactory = (id) => ({
    async checkAvailability() { calls.push(id); return { status: "miss" }; },
  });
  const fallback = await startPlaybackSource(source, {
    config, providerFactory, startLocal: async () => ({ id: "fallback", status: "loading" }),
  });
  assert.deepEqual(calls, ["real-debrid", "torbox"]);
  assert.equal(fallback.id, "fallback");
  await assert.rejects(startPlaybackSource(source, {
    config: { ...config, mode: "debrid-only" }, providerFactory,
    startLocal: async () => { throw new Error("Local must not start"); },
  }), (error) => error.code === "not-cached");
  await assert.rejects(startPlaybackSource(source, {
    config: { ...config, localFallback: false }, providerFactory,
    startLocal: async () => { throw new Error("Local must not start"); },
  }), (error) => error.code === "not-cached");
});

test("file matching rejects samples, extras, and ambiguous episodes", () => {
  const files = [
    { name: "sample.mp4", size: 10_000_000 },
    { name: "Film.mp4", size: 9_000_000 },
  ];
  assert.equal(findLargestFile(files).name, "Film.mp4");
  assert.equal(findEpisodeFile([
    { name: "Show.S01E03.mkv" },
    { name: "Extras/Show.S01E03.mkv", relativePath: "Extras/Show.S01E03.mkv" },
  ], 1, 3)?.name, "Show.S01E03.mkv");
  assert.equal(findEpisodeFile([
    { name: "Show.S01E03.720p.mkv" },
    { name: "Show.S01E03.1080p.mkv" },
  ], 1, 3), null);
});
