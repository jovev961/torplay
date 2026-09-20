import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSameOriginSettingsRequest,
  assertSettingsMutationRequest,
  isLocalNetworkSettingsRequest,
} from "../lib/settings/security.js";
import { GET as getSettings } from "../app/api/settings/route.js";

function request(host, { origin = `http://${host}`, contentType = "application/json", forwardedFor } = {}) {
  return new Request(`http://${host}/api/settings`, {
    headers: {
      host,
      origin,
      "content-type": contentType,
      ...(forwardedFor !== undefined ? { "x-forwarded-for": forwardedFor } : {}),
    },
  });
}

test("recognizes loopback, configured hostnames, and private LAN addresses", () => {
  for (const host of [
    "localhost:3000",
    "127.0.0.1",
    "[::1]:3000",
    "torplay.local",
    "192.168.1.20:3000",
    "10.0.0.8",
    "172.20.0.5",
    "[fd00::5]:3000",
  ]) {
    assert.equal(isLocalNetworkSettingsRequest(request(host)), true, host);
  }
  assert.equal(
    isLocalNetworkSettingsRequest(request("living-room.local"), {
      environment: { TORPLAY_PUBLIC_HOSTNAME: "living-room.local" },
    }),
    true,
  );
});

test("rejects public hosts and forwarded chains containing public addresses", () => {
  for (const [host, forwardedFor] of [
    ["example.com", undefined],
    ["fcorp.example", undefined],
    ["203.0.113.4", undefined],
    ["torplay.local", "203.0.113.4"],
    ["torplay.local", "192.168.1.20, 203.0.113.4"],
    ["torplay.local", ""],
  ]) {
    assert.equal(isLocalNetworkSettingsRequest(request(host, { forwardedFor })), false, `${host} ${forwardedFor || ""}`);
  }
  assert.equal(
    isLocalNetworkSettingsRequest(request("torplay.local", { forwardedFor: "192.168.1.20, 127.0.0.1" })),
    true,
  );
});

test("allows only same-origin JSON mutations from the private local network", () => {
  assert.doesNotThrow(() => assertSettingsMutationRequest(request("localhost:3000")));
  assert.doesNotThrow(() => assertSettingsMutationRequest(request("torplay.local", { forwardedFor: "192.168.1.20" })));
  assert.throws(
    () => assertSettingsMutationRequest(request("torplay.local", { origin: "https://attacker.example" })),
    (error) => error.status === 403 && /same TorPlay origin/.test(error.message),
  );
  assert.throws(
    () => assertSettingsMutationRequest(request("localhost:3000", { contentType: "text/plain" })),
    (error) => error.status === 415,
  );
});

test("returns an editable LAN snapshot without exposing secret settings", async () => {
  const previous = process.env.TMDB_API_TOKEN;
  process.env.TMDB_API_TOKEN = "issue-70-secret-marker";
  try {
    const response = await getSettings(request("torplay.local"));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).canEdit, true);
    assert.equal(text.includes("issue-70-secret-marker"), false);
  } finally {
    if (previous === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previous;
  }
});

test("validation requests require an exact same origin", () => {
  assert.doesNotThrow(() => assertSameOriginSettingsRequest(request("torplay.local")));
  assert.throws(
    () => assertSameOriginSettingsRequest(request("torplay.local", { origin: "http://torplay.local:3000" })),
    (error) => error.status === 403,
  );
});
