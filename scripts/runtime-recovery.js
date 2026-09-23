function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createRestartBudget({
  maxAttempts = 3,
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  let attempts = [];
  return {
    reserve() {
      const current = now();
      attempts = attempts.filter((timestamp) => current - timestamp < windowMs);
      if (attempts.length >= maxAttempts) {
        return { allowed: false, attempt: attempts.length, maxAttempts, windowMs };
      }
      attempts.push(current);
      return { allowed: true, attempt: attempts.length, maxAttempts, windowMs };
    },
  };
}

export function createComponentRecovery({
  name,
  restart,
  onAttempt = () => {},
  onRecovered = () => {},
  onPersistentFailure = () => {},
  log = console.log,
  maxAttempts = 3,
  windowMs = 60_000,
  now = Date.now,
  waitProcess = wait,
} = {}) {
  const budget = createRestartBudget({ maxAttempts, windowMs, now });
  let active = null;
  let disabled = false;
  let blocked = false;

  async function run(reason) {
    let failure = reason instanceof Error ? reason : new Error(String(reason));
    while (!disabled) {
      const reservation = budget.reserve();
      if (!reservation.allowed) {
        blocked = true;
        const error = new Error(
          `${name} exceeded ${maxAttempts} recovery attempts within ${Math.ceil(windowMs / 1_000)} seconds. ${failure.message}`,
        );
        log(`[TorPlay] Persistent ${name} failure: ${error.message}`);
        onPersistentFailure(error);
        return false;
      }

      log(
        `[TorPlay] Recovering ${name} (attempt ${reservation.attempt}/${maxAttempts}): ${failure.message}`,
      );
      onAttempt(failure, reservation);
      try {
        await restart();
        if (disabled) return false;
        log(`[TorPlay] ${name} recovered.`);
        onRecovered(reservation);
        return true;
      } catch (error) {
        failure = error;
        log(`[TorPlay] ${name} recovery attempt failed: ${error.message}`);
        if (reservation.attempt < maxAttempts) {
          await waitProcess(Math.min(reservation.attempt * 1_000, 5_000));
        }
      }
    }
    return false;
  }

  return {
    recover(reason) {
      if (disabled || blocked) return Promise.resolve(false);
      if (!active) {
        active = run(reason).finally(() => {
          active = null;
        });
      }
      return active;
    },
    disable() {
      disabled = true;
    },
    isBlocked() {
      return blocked;
    },
  };
}

export function startHealthMonitor({
  inspect,
  onFailure,
  onError = (error) => console.error(error),
  failureThreshold = 2,
  intervalMs = 15_000,
  setIntervalProcess = setInterval,
  clearIntervalProcess = clearInterval,
} = {}) {
  let stopped = false;
  let checking = false;
  let failureKey = null;
  let failures = 0;

  async function checkNow() {
    if (stopped || checking) return;
    checking = true;
    try {
      const failure = await inspect();
      if (!failure) {
        failureKey = null;
        failures = 0;
        return;
      }
      if (failure.component === failureKey) failures += 1;
      else {
        failureKey = failure.component;
        failures = 1;
      }
      if (failures >= failureThreshold) {
        failures = 0;
        await onFailure(failure);
      }
    } catch (error) {
      onError(error);
    } finally {
      checking = false;
    }
  }

  const timer = setIntervalProcess(() => void checkNow(), intervalMs);
  timer.unref?.();
  return {
    checkNow,
    stop() {
      stopped = true;
      clearIntervalProcess(timer);
    },
  };
}
