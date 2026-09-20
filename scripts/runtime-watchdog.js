const watchdogKey = Symbol.for("torplay.runtimeWatchdog");

export function supervisorIsRunning(pid, killProcess = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function exitIfSupervisorStopped({
  supervisorPid = Number(process.env.TORPLAY_SUPERVISOR_PID),
  killProcess = process.kill,
  exitProcess = process.exit,
} = {}) {
  if (supervisorIsRunning(supervisorPid, killProcess)) return false;
  exitProcess(1);
  return true;
}

export function startSupervisorWatchdog({
  supervisorPid = Number(process.env.TORPLAY_SUPERVISOR_PID),
  intervalMs = 2_000,
  setIntervalProcess = setInterval,
} = {}) {
  if (!Number.isInteger(supervisorPid) || supervisorPid < 1 || globalThis[watchdogKey]) return null;
  const timer = setIntervalProcess(() => exitIfSupervisorStopped({ supervisorPid }), intervalMs);
  timer.unref?.();
  globalThis[watchdogKey] = timer;
  return timer;
}

startSupervisorWatchdog();
