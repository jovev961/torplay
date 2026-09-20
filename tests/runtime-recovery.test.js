import assert from "node:assert/strict";
import test from "node:test";
import {
  createComponentRecovery,
  createRestartBudget,
  startHealthMonitor,
} from "../scripts/runtime-recovery.js";

test("restart budgets reject loops until the time window expires", () => {
  let current = 0;
  const budget = createRestartBudget({ maxAttempts: 2, windowMs: 100, now: () => current });
  assert.deepEqual(budget.reserve(), { allowed: true, attempt: 1, maxAttempts: 2, windowMs: 100 });
  assert.equal(budget.reserve().allowed, true);
  assert.equal(budget.reserve().allowed, false);
  current = 101;
  assert.equal(budget.reserve().allowed, true);
});

test("component recovery retries with backoff then exposes a persistent failure", async () => {
  const states = [];
  const delays = [];
  const logs = [];
  let restarts = 0;
  const recovery = createComponentRecovery({
    name: "TorPlay",
    maxAttempts: 3,
    restart: async () => {
      restarts += 1;
      throw new Error(`failure ${restarts}`);
    },
    onAttempt: (_error, reservation) => states.push(`attempt-${reservation.attempt}`),
    onPersistentFailure: (error) => states.push(error.message),
    waitProcess: async (milliseconds) => { delays.push(milliseconds); },
    log: (message) => logs.push(message),
  });

  assert.equal(await recovery.recover(new Error("process exited")), false);
  assert.equal(restarts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(recovery.isBlocked(), true);
  assert.equal(await recovery.recover(new Error("again")), false);
  assert.match(states.at(-1), /exceeded 3 recovery attempts/);
  assert.equal(logs.some((message) => message.includes("failure 3")), true);
});

test("health monitoring requires consecutive failures and avoids overlapping checks", async () => {
  const observations = [
    { component: "TorPlay", error: new Error("one") },
    null,
    { component: "LAN proxy", error: new Error("one") },
    { component: "LAN proxy", error: new Error("two") },
  ];
  const failures = [];
  let timerStopped = false;
  const monitor = startHealthMonitor({
    inspect: async () => observations.shift(),
    onFailure: async (failure) => { failures.push(failure.component); },
    failureThreshold: 2,
    setIntervalProcess: () => ({ unref() {} }),
    clearIntervalProcess: () => { timerStopped = true; },
  });

  await monitor.checkNow();
  await monitor.checkNow();
  await monitor.checkNow();
  await monitor.checkNow();
  assert.deepEqual(failures, ["LAN proxy"]);
  monitor.stop();
  await monitor.checkNow();
  assert.equal(timerStopped, true);
});
