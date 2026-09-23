import assert from "node:assert/strict";
import test from "node:test";
import { requestFlareSolverr, validateFlareSolverrEndpoint } from "../lib/search/cardigann/flaresolverr.js";

const safeTarget = async (hostname) => {
  if (hostname !== "indexer.example") throw new Error("blocked target");
};
const solution = (overrides = {}) => new Response(JSON.stringify({ status: "ok", solution: {
  url: "https://indexer.example/search", status: 200, response: "<html>ok</html>",
  cookies: [{ name: "session", value: "abc", path: "/" }], userAgent: "Browser UA", ...overrides,
} }));

test("FlareSolverr accepts only local or private service endpoints", async () => {
  assert.equal((await validateFlareSolverrEndpoint("http://localhost:8191")).pathname, "/v1");
  await assert.rejects(validateFlareSolverrEndpoint("https://public.example", async () => [{ address: "8.8.8.8" }]), { code: "FLARESOLVERR_URL_BLOCKED" });
  await assert.rejects(validateFlareSolverrEndpoint("http://user:secret@localhost:8191"), { code: "FLARESOLVERR_URL_INVALID" });
});

test("FlareSolverr forwards compatible form requests and returns cookies and user agent", async () => {
  let payload;
  const response = await requestFlareSolverr("https://indexer.example/search", {
    endpoint: "http://localhost:8191", method: "POST", body: "q=authorized",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "existing=one" },
    validateTarget: safeTarget,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "http://localhost:8191/v1");
      payload = JSON.parse(options.body);
      return solution();
    },
  });
  assert.equal(payload.cmd, "request.post");
  assert.equal(payload.postData, "q=authorized");
  assert.deepEqual(payload.cookies, [{ name: "existing", value: "one" }]);
  assert.equal(response.headers["x-torplay-flaresolverr-user-agent"], "Browser UA");
  assert.match(response.headers["set-cookie"][0], /^session=abc/);
});

test("FlareSolverr rejects unsafe redirects, unsupported headers and oversized bodies", async () => {
  const options = { endpoint: "http://localhost:8191", validateTarget: safeTarget };
  await assert.rejects(requestFlareSolverr("https://indexer.example/search", {
    ...options, headers: { Authorization: "secret" }, fetchImpl: async () => solution(),
  }), { code: "FLARESOLVERR_REQUEST_UNSUPPORTED" });
  await assert.rejects(requestFlareSolverr("https://indexer.example/search", {
    ...options, fetchImpl: async () => solution({ url: "http://127.0.0.1/admin" }),
  }), { code: "FLARESOLVERR_TARGET_BLOCKED" });
  await assert.rejects(requestFlareSolverr("https://indexer.example/search", {
    ...options, maxBytes: 2, fetchImpl: async () => solution(),
  }), { code: "FLARESOLVERR_RESPONSE_TOO_LARGE" });
});
