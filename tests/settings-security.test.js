import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSameOriginSettingsRequest,
  assertSettingsMutationRequest,
  isLoopbackSettingsRequest,
} from "../lib/settings/security.js";

function request(host, { origin = `http://${host}`, contentType = "application/json", forwardedFor } = {}) {
  return new Request(`http://${host}/api/settings`, {
    headers: {
      host,
      origin,
      "content-type": contentType,
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
  });
}

test("recognizes loopback hosts and keeps LAN hosts read-only", () => {
  assert.equal(isLoopbackSettingsRequest(request("localhost:3000")), true);
  assert.equal(isLoopbackSettingsRequest(request("127.0.0.1")), true);
  assert.equal(isLoopbackSettingsRequest(request("[::1]:3000")), true);
  assert.equal(isLoopbackSettingsRequest(request("localhost", { forwardedFor: "::ffff:127.0.0.1" })), true);
  assert.equal(isLoopbackSettingsRequest(request("localhost", { forwardedFor: "192.168.1.20" })), false);
  assert.equal(isLoopbackSettingsRequest(request("localhost", { forwardedFor: "127.0.0.1, 192.168.1.20" })), false);
  assert.equal(isLoopbackSettingsRequest(request("torplay.local")), false);
  assert.equal(isLoopbackSettingsRequest(request("192.168.1.20")), false);
});

test("allows only same-origin JSON mutations from localhost", () => {
  assert.doesNotThrow(() => assertSettingsMutationRequest(request("localhost:3000")));
  assert.throws(
    () => assertSettingsMutationRequest(request("torplay.local")),
    (error) => error.status === 403 && /localhost/.test(error.message),
  );
  assert.throws(
    () => assertSettingsMutationRequest(request("localhost:3000", { origin: "https://attacker.example" })),
    (error) => error.status === 403 && /same TorPlay origin/.test(error.message),
  );
  assert.throws(
    () => assertSettingsMutationRequest(request("localhost:3000", { contentType: "text/plain" })),
    (error) => error.status === 415,
  );
});

test("validation requests require an exact same origin", () => {
  assert.doesNotThrow(() => assertSameOriginSettingsRequest(request("torplay.local")));
  assert.throws(
    () => assertSameOriginSettingsRequest(request("torplay.local", { origin: "http://torplay.local:3000" })),
    (error) => error.status === 403,
  );
});
