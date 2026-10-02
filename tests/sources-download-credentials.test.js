import assert from "node:assert/strict";
import test from "node:test";
import { search } from "../lib/sources/discovery.js";
import { resolve } from "../lib/sources/results.js";
import { diagnostic } from "../lib/sources/contract.js";
import { cardigann, definition, magnet, movie, mockNetwork } from "./helpers/sources-fixtures.js";

const secret = "synthetic-download-secret";
const sourceOrigin = "https://fixture.example";
const foreign = "https://other.example/private-download";

function downloadSource(headers, download = {}) {
  const def = definition({
    settings: [{ name: "token", type: "password" }],
    download: { headers, ...download },
  });
  return { ...cardigann(def), settings: { token: secret } };
}

async function selection(source) {
  const result = await search(movie, { sources: [source], environment: {}, refresh: true });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics[0].status, "ready");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-download-secret|private-download|other\.example|magnet:|locator/);
  const descriptor = resolve(result.candidates[0].id, "torrent");
  assert.equal(typeof descriptor.resolver, "function");
  return descriptor;
}

for (const header of ["Authorization", "authorization", "Cookie", "X-API-Key", "X-Auth-Token"]) {
  for (const stage of ["initial URL", "download selector", "preparation path", "preparation selector", "redirect", "HTTP destination"]) {
    test(`Cardigann ${header} stays at source origin through ${stage}`, async (t) => {
      const headers = { [header]: [header === "Cookie" ? "session={{ .Config.token }}" : "{{ .Config.token }}"] };
      const download = stage === "download selector" ? { selectors: [{ selector: "a.next", attribute: "href" }] }
        : stage === "preparation path" ? { before: { path: foreign } }
          : stage === "preparation selector" ? { before: { pathselector: { selector: "a.next", attribute: "href" } } } : {};
      const initial = stage === "initial URL" ? foreign : stage === "HTTP destination"
        ? "http://fixture.example/private-download" : `${sourceOrigin}/private-download`;
      const calls = mockNetwork(t, ({ url }) => {
        if (url.pathname === "/search") return { body: `<div class="release"><span class="name">The Tailor 2023</span><a href="${initial}">get</a></div>` };
        if (stage === "redirect") return { status: 302, headers: { location: foreign } };
        return { body: `<html><a class="next" href="${foreign}">next</a>${magnet}</html>` };
      });
      const descriptor = await selection(downloadSource(headers, download));
      await assert.rejects(descriptor.resolver(), (error) => {
        assert.doesNotMatch(`${error.message} ${JSON.stringify(diagnostic(error))}`, /synthetic-download-secret|private-download|other\.example|magnet:/);
        return error.code === (stage === "HTTP destination" ? "REMOTE_URL_UNSUPPORTED" : "REMOTE_REDIRECT_BLOCKED");
      });
      assert.ok(calls.length >= 1);
      assert.ok(calls.every((call) => call.url.origin === sourceOrigin));
      const downloads = calls.filter((call) => call.url.pathname !== "/search");
      if (!["initial URL", "HTTP destination", "preparation path"].includes(stage)) {
        assert.ok(downloads.length > 0);
      } else assert.equal(downloads.length, 0);
    });
  }
}

for (const header of ["Authorization", "authorization", "Cookie", "X-API-Key", "X-Auth-Token"]) {
  test(`Cardigann ${header} authenticated same-origin download and redirect remain usable`, async (t) => {
    const calls = mockNetwork(t, ({ url }) => {
      if (url.pathname === "/search") return { body: '<div class="release"><span class="name">The Tailor 2023</span><a href="/private-download">get</a></div>' };
      if (url.pathname === "/private-download") return { status: 302, headers: { location: "/final" } };
      return { body: `<html>${magnet}</html>` };
    });
    const descriptor = await selection(downloadSource({ [header]: [header === "Cookie" ? "session={{ .Config.token }}" : "{{ .Config.token }}"] }));
    assert.equal((await descriptor.resolver()).magnet, magnet);
    assert.deepEqual(calls.map((call) => call.url.pathname), ["/search", "/private-download", "/final"]);
    const expected = header === "Cookie" ? `session=${secret}` : secret;
    assert.ok(calls.slice(1).every((call) => String(call.headers[header]) === expected), "configured authentication must reach same-origin download requests");
  });
}

for (const stage of ["initial URL", "download selector", "redirect"]) {
  test(`Cardigann credential-free cross-origin ${stage} remains usable`, async (t) => {
    const source = downloadSource({}, stage === "download selector" ? { selectors: [{ selector: "a.next", attribute: "href" }] } : {});
    const calls = mockNetwork(t, ({ url }) => {
      if (url.pathname === "/search") return { body: `<div class="release"><span class="name">The Tailor 2023</span><a href="${stage === "initial URL" ? foreign : "/private-download"}">get</a></div>` };
      if (url.origin === sourceOrigin) return stage === "redirect" ? { status: 302, headers: { location: foreign } }
        : { body: `<html><a class="next" href="${foreign}">next</a></html>` };
      return { body: `<html>${magnet}</html>` };
    });
    const descriptor = await selection(source);
    assert.equal((await descriptor.resolver()).magnet, magnet);
    assert.ok(calls.some((call) => call.url.origin === "https://other.example"));
    assert.ok(calls.every((call) => !Object.entries(call.headers).some(([key, value]) => /authorization|cookie|token|key/i.test(key) && String(value))));
  });
}

test("Cardigann server-set cookie authentication survives same-origin downloads", async (t) => {
  const expected = `session=${secret}`;
  const calls = mockNetwork(t, ({ url }) => {
    if (url.pathname === "/search") return {
      headers: { "set-cookie": `${expected}; Path=/; Secure; HttpOnly` },
      body: '<div class="release"><span class="name">The Tailor 2023</span><a href="/private-download">get</a></div>',
    };
    if (url.pathname === "/private-download") return { status: 302, headers: { location: "/final" } };
    return { body: `<html>${magnet}</html>` };
  });
  const descriptor = await selection(downloadSource({}));
  assert.equal((await descriptor.resolver()).magnet, magnet);
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/search", "/private-download", "/final"]);
  assert.ok(calls.slice(1).every((call) => call.headers.Cookie === expected));
});
