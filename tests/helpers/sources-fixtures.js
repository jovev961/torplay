import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const hash = "1234567890abcdef1234567890abcdef12345678";
export const magnet = `magnet:?xt=urn:btih:${hash}`;
export const movie = { title: "The Tailor", type: "movie", year: 2023 };
export const episode = { title: "The Tailor", type: "show", season: 2, episode: 3, imdbId: "tt1234567" };
export function response(body, url = "https://fixture.example/search", status = 200, headers = {}) {
  return { body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), url: new URL(url), status, headers };
}
export function definition(overrides = {}) {
  const result = { id: "synthetic", name: "Synthetic Source", description: "Independent fixture", language: "en-US",
    type: "public", encoding: "UTF-8", links: ["https://fixture.example/"],
    caps: { categories: { 10: "Movies", 20: "TV" }, modes: { search: ["q"] } },
    search: { paths: [{ path: "search", inputs: { q: "{{ .Keywords }}" } }], rows: { selector: ".release" },
      fields: { title: { selector: ".name" }, magnet: { selector: "a", attribute: "href" }, seeders: { selector: ".seeds" } } }, ...overrides };
  result.search.fields = { category: { text: "10" }, size: { text: "1000" }, seeders: { text: "12" }, ...result.search.fields };
  return result;
}
export function cardigann(def = definition()) {
  return { id: `fixture-${randomUUID()}`, name: def.name, kind: "cardigann", enabled: true,
    definition: def, definitionHash: randomUUID(), settings: {}, compatibility: { supported: true }, capabilities: { mediaTypes: ["Movies", "TV"] } };
}
export function torznab(id = "fixture", overrides = {}) {
  return { id, name: `Source ${id}`, kind: "torznab", enabled: true, endpoint: `https://${id}.example/api`,
    apiKey: "synthetic-secret", capabilities: { mediaTypes: ["Movies", "TV"], modes: { search: ["q"] } }, ...overrides };
}
export function rss(title = "The Tailor 2023 1080p", extra = "", torrentHash = hash) {
  return `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>${title}</title>
    <torznab:attr name="infohash" value="${torrentHash}"/><torznab:attr name="seeders" value="12"/>${extra}</item></channel></rss>`;
}
export function html(title = "The Tailor 2023 1080p") {
  return `<div class="release"><span class="name">${title}</span><a href="${magnet}">get</a><span class="seeds">12</span></div>`;
}
export async function settingsFixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-source-tests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, environment: { TORPLAY_CONFIG_PATH: path.join(directory, ".env.local"), ...extra },
    write: (filename, value) => writeFile(path.join(directory, filename), JSON.stringify(value)) };
}

// Exercise the real network guard/redirect/body logic without opening sockets.
export function mockNetwork(t, handler, addresses = [{ address: "93.184.216.34", family: 4 }]) {
  const calls = [];
  t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, addresses));
  const exchange = (url, options, callback) => {
    const req = new EventEmitter();
    let stopped = false;
    let activeResponse;
    const abort = () => req.destroy(Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORT_ERR" }));
    req.destroy = (error) => {
      if (stopped) return;
      stopped = true;
      activeResponse?.destroy();
      options.signal?.removeEventListener("abort", abort);
      if (error) req.emit("error", error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    req.end = (body) => {
      const call = { url: new URL(url), ...options, body };
      calls.push(call);
      Promise.resolve().then(() => handler(call)).then((reply) => {
        if (stopped) return;
        const stream = Readable.from([Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? "")]);
        activeResponse = stream;
        stream.statusCode = reply.status ?? 200;
        stream.headers = reply.headers ?? {};
        stream.once("end", () => options.signal?.removeEventListener("abort", abort));
        callback(stream);
      }, (error) => req.destroy(error));
    };
    return req;
  };
  t.mock.method(http, "request", exchange);
  t.mock.method(https, "request", exchange);
  return calls;
}
