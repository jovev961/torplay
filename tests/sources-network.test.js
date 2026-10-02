import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { endpointUrl, destination, request, validateFlareSolverrEndpoint, withDeadline } from "../lib/network/request.js";
import { mockNetwork } from "./helpers/sources-fixtures.js";

for (const url of ["http://external.example/", "https://user:password@external.example/", "file:///private", "https://external.example/#secret"]) {
  test(`external endpoint rejects unsupported URL ${url.split(":")[0]}`, () => assert.throws(() => endpointUrl(url)));
}

test("external DNS blocks internal, link-local, mapped IPv4 and mixed destinations", async () => {
  for (const addresses of [["127.0.0.1"], ["10.1.1.1"], ["169.254.169.254"], ["::1"], ["fc00::1"], ["::ffff:127.0.0.1"], ["93.184.216.34", "127.0.0.1"]]) {
    await assert.rejects(destination("synthetic.example", { lookup: (_host, _options, callback) => callback(null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))) }), { code: "REMOTE_DESTINATION_BLOCKED" });
  }
});

test("configured services may use LAN while solver requires local and rejects link-local", async () => {
  const lookup = (address) => (_host, _options, callback) => callback(null, [{ address, family: 4 }]);
  assert.equal((await destination("personal.example", { policy: "configured-service", lookup: lookup("192.168.1.2") })).address, "192.168.1.2");
  assert.equal((await validateFlareSolverrEndpoint("http://solver.local:8191", lookup("127.0.0.1"))).pathname, "/v1");
  await assert.rejects(validateFlareSolverrEndpoint("https://public.example/", lookup("93.184.216.34")), { code: "REMOTE_DESTINATION_BLOCKED" });
  await assert.rejects(destination("metadata.example", { policy: "configured-service", lookup: lookup("169.254.169.254") }), { code: "REMOTE_DESTINATION_BLOCKED" });
});

test("redirect validates destination again and never reaches a private target", async (t) => {
  const calls = mockNetwork(t, () => ({ status: 302, headers: { location: "https://blocked.example/private" }, body: "" }));
  const dns = await import("node:dns");
  t.mock.method(dns.default, "lookup", (host, _options, callback) => callback(null, [{ address: host === "blocked.example" ? "127.0.0.1" : "93.184.216.34", family: 4 }]));
  await assert.rejects(request("https://external.example/start"), { code: "REMOTE_DESTINATION_BLOCKED" });
  assert.equal(calls.length, 1);
});

test("cross-origin redirect strips credentials and pinned DNS lookup uses checked address", async (t) => {
  const calls = mockNetwork(t, ({ url, lookup }) => {
    lookup(url.hostname, {}, (_error, address) => assert.equal(address, "93.184.216.34"));
    return url.hostname === "external.example" ? { status: 302, headers: { location: "https://next.example/" } } : { body: "ok" };
  });
  assert.equal((await request("https://external.example/", { headers: { Authorization: "Bearer secret", Cookie: "session=secret", "X-API-Key": "secret", Accept: "text/html" } })).body.toString(), "ok");
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls[1].headers["X-API-Key"], undefined);
  assert.equal(calls[1].headers.Accept, "text/html");
});

test("HTTPS downgrade, cross-origin credential body and same-origin redirects are blocked", async (t) => {
  const calls = mockNetwork(t, ({ url }) => ({ status: 307, headers: { location: url.pathname === "/downgrade" ? "http://external.example/" : "https://next.example/" } }));
  await assert.rejects(request("https://external.example/downgrade", { protocols: ["http:", "https:"] }), { code: "REMOTE_REDIRECT_BLOCKED" });
  await assert.rejects(request("https://external.example/", { method: "POST", body: "credential=secret" }), { code: "REMOTE_REDIRECT_BLOCKED" });
  await assert.rejects(request("https://external.example/", { sameOrigin: true }), { code: "REMOTE_REDIRECT_BLOCKED" });
  assert.equal(calls.length, 3);
});

test("redirect loops are bounded", async (t) => {
  const calls = mockNetwork(t, () => ({ status: 302, headers: { location: "/again" } }));
  await assert.rejects(request("https://external.example/", { maxRedirects: 2 }), { code: "REMOTE_REDIRECT_INVALID" });
  assert.equal(calls.length, 3);
});

test("raw and decompressed response sizes are bounded", async (t) => {
  mockNetwork(t, ({ url }) => url.pathname === "/gzip" ? { body: gzipSync(Buffer.alloc(1024)), headers: { "content-encoding": "gzip" } } : { body: Buffer.alloc(1024) });
  await assert.rejects(request("https://external.example/raw", { maxBytes: 100 }), { code: "REMOTE_RESPONSE_TOO_LARGE" });
  await assert.rejects(request("https://external.example/gzip", { maxBytes: 100 }));
});

test("whole-request deadline aborts hung exchange and sanitizes transport errors", async (t) => {
  let signal;
  mockNetwork(t, (call) => { signal = call.signal; return new Promise(() => {}); });
  await assert.rejects(request("https://external.example/?token=secret", { timeoutMs: 20 }), (error) => {
    assert.equal(error.status, 504); assert.ok(!error.message.includes("secret")); return true;
  });
  assert.equal(signal.aborted, true);
});

test("deadline and caller cancellation are bounded even for noncooperative operations", async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), { timeoutMs: 10 }), { name: "TimeoutError" });
  const controller = new AbortController();
  const run = withDeadline(() => new Promise(() => {}), { signal: controller.signal });
  controller.abort(); await assert.rejects(run, { name: "AbortError" });
});
