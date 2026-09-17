import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  COMPOSE_START_ARGS,
  COMPOSE_STOP_ARGS,
  startDevelopment,
} from "../scripts/dev.js";

class FakeChild extends EventEmitter {
  constructor({ exitCode = null, autoExit } = {}) {
    super();
    this.exitCode = exitCode;
    this.killed = false;
    this.signals = [];
    if (autoExit !== undefined) {
      queueMicrotask(() => {
        this.exitCode = autoExit;
        this.emit("exit", autoExit, null);
      });
    }
  }

  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}

test("starts Docker services before Next and stops them without removing containers", async () => {
  const calls = [];
  const next = new FakeChild();
  const children = [
    () => new FakeChild({ autoExit: 0 }),
    () => next,
  ];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    return children.shift()();
  };
  const spawnSyncProcess = (command, args) => {
    calls.push({ command, args });
    return { status: 0 };
  };

  const supervisor = await startDevelopment({
    spawnProcess,
    spawnSyncProcess,
    configureJackettProcess: () => ({ changed: false, hasOmdbKey: false }),
    dockerCommand: "docker",
  });
  assert.deepEqual(calls[0], { command: "docker", args: COMPOSE_START_ARGS });
  assert.equal(calls.length, 2);

  supervisor.stop("SIGINT");
  supervisor.stop("SIGTERM");
  assert.deepEqual(calls[2], { command: "docker", args: COMPOSE_STOP_ARGS });
  assert.deepEqual(next.signals, ["SIGINT"]);
  assert.equal(calls.filter((call) => call.args.includes("stop")).length, 1);
  assert.equal(calls.some((call) => call.args.includes("down")), false);
});

test("does not start Next and cleans up when Docker service startup fails", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    return new FakeChild({ autoExit: 1 });
  };
  const spawnSyncProcess = (command, args) => {
    calls.push({ command, args });
    return { status: 0 };
  };

  await assert.rejects(
    () => startDevelopment({ spawnProcess, spawnSyncProcess, dockerCommand: "docker" }),
    /Development services failed with exit code 1/,
  );
  assert.deepEqual(calls[1], { command: "docker", args: COMPOSE_STOP_ARGS });
  assert.equal(calls.length, 2);
});

test("cleans up Docker services when Jackett configuration fails", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    return new FakeChild({ autoExit: 0 });
  };
  const spawnSyncProcess = (command, args) => {
    calls.push({ command, args });
    return { status: 0 };
  };

  await assert.rejects(
    () => startDevelopment({
      spawnProcess,
      spawnSyncProcess,
      configureJackettProcess: () => {
        throw new Error("configuration failed");
      },
      dockerCommand: "docker",
    }),
    /configuration failed/,
  );
  assert.deepEqual(calls.at(-1), { command: "docker", args: COMPOSE_STOP_ARGS });
});
