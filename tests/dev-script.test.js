import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startDevelopment } from "../scripts/dev.js";
import { readLocalEnvironment } from "../scripts/local-environment.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killed = false;
    this.signals = [];
  }

  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}

test("development starts only Next even with an obsolete managed-service setting", async () => {
  const next = new FakeChild();
  const calls = [];
  const supervisor = await startDevelopment({
    environment: { TORPLAY_MANAGED_JACKETT: "true" },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return next;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args.at(-1), "dev");
  assert.equal(calls[0].options.env.TORPLAY_MANAGED_JACKETT, "true");

  supervisor.stop("SIGINT");
  supervisor.stop("SIGTERM");
  assert.equal(next.killed, true);
  assert.deepEqual(next.signals, ["SIGINT"]);
});

test("reads quoted values from the local environment file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-env-"));
  const filePath = path.join(directory, ".env.local");
  try {
    writeFileSync(filePath, "OMDB_API_KEY='secret-key'\nIGNORED=value\n", "utf8");
    assert.deepEqual(readLocalEnvironment(filePath), {
      OMDB_API_KEY: "secret-key",
      IGNORED: "value",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
