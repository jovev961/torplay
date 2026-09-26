export const WATCH_TOGETHER_SNAPSHOT_INTERVAL_MS = 2_000;
export const WATCH_TOGETHER_SOFT_DRIFT_SECONDS = 0.35;
export const WATCH_TOGETHER_HARD_DRIFT_SECONDS = 2;
export const WATCH_TOGETHER_SETTLED_DRIFT_SECONDS = 0.2;

export function durationsCompatible(hostDuration, guestDuration) {
  const host = Number(hostDuration);
  const guest = Number(guestDuration);
  if (!(host > 0) || !(guest > 0)) return false;
  return Math.abs(host - guest) <= Math.max(5, host * 0.01);
}

export function estimateClockOffset({ sentAt, hostAt, receivedAt }) {
  const start = Number(sentAt);
  const host = Number(hostAt);
  const end = Number(receivedAt);
  if (![start, host, end].every(Number.isFinite) || end < start) return 0;
  return host + (end - start) / 2 - end;
}

export function projectedHostPosition(snapshot, guestNow, hostClockOffset = 0) {
  const position = Math.max(0, Number(snapshot?.position) || 0);
  if (!snapshot?.playing) return position;
  const hostSentAtInGuestClock = (Number(snapshot.sentAt) || guestNow) - hostClockOffset;
  return Math.max(0, position + Math.max(0, guestNow - hostSentAtInGuestClock) / 1000);
}

export function guestCorrection({ currentTime, targetTime, playing }) {
  const current = Math.max(0, Number(currentTime) || 0);
  const target = Math.max(0, Number(targetTime) || 0);
  const drift = target - current;
  const absolute = Math.abs(drift);
  // A Play click is sent as an explicit snapshot, but must not force another
  // HLS source rebuild after the coordinated seek barrier. Large drift still
  // seeks; small drift is corrected without replacing the buffered source.
  if (!playing || absolute > WATCH_TOGETHER_HARD_DRIFT_SECONDS) {
    return { kind: absolute > 0.05 ? "seek" : "none", target, drift, rate: 1 };
  }
  if (absolute < WATCH_TOGETHER_SETTLED_DRIFT_SECONDS) {
    return { kind: "rate", target, drift, rate: 1 };
  }
  if (absolute >= WATCH_TOGETHER_SOFT_DRIFT_SECONDS) {
    return { kind: "rate", target, drift, rate: drift > 0 ? 1.05 : 0.95 };
  }
  return { kind: "none", target, drift, rate: 1 };
}
