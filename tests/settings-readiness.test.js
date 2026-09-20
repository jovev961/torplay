import assert from "node:assert/strict";
import test from "node:test";
import { getSetupStatus, setupStatusFromProviders } from "../lib/settings/readiness.js";

test("setup readiness reports each missing required provider", () => {
  assert.deepEqual(setupStatusFromProviders([
    { id: "tmdb", required: true, configured: false },
    { id: "jackett", required: true, configured: true },
    { id: "omdb", required: false, configured: false },
  ]), { ready: false, missingProviderIds: ["tmdb"] });
  assert.deepEqual(setupStatusFromProviders([
    { id: "tmdb", required: true, configured: true },
    { id: "jackett", required: true, configured: true },
  ]), { ready: true, missingProviderIds: [] });
});

test("setup readiness treats blanks and template placeholders as missing", async () => {
  const missing = await getSetupStatus({
    environment: { TMDB_API_TOKEN: "replace-me", JACKETT_API_KEY: "" },
  });
  assert.deepEqual(missing, { ready: false, missingProviderIds: ["tmdb"] });

  const ready = await getSetupStatus({
    environment: {
      TMDB_API_TOKEN: "read-access-token",
      JACKETT_API_KEY: "jackett-key",
    },
  });
  assert.deepEqual(ready, { ready: true, missingProviderIds: [] });
});
