export function clampSeekTarget(target, duration) {
  const position = Number(target);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(duration, position));
}

export function skipTarget(position, pendingTarget, seconds, duration) {
  return clampSeekTarget((pendingTarget ?? position) + seconds, duration);
}

export function localSeekPosition(target, originSeconds, seekable) {
  const absolute = Number(target);
  const origin = Number(originSeconds);
  if (!Number.isFinite(absolute) || !Number.isFinite(origin) || absolute < origin || !seekable) {
    return null;
  }
  const local = absolute - origin;
  for (let index = 0; index < Number(seekable.length || 0); index += 1) {
    const start = Number(seekable.start(index));
    const end = Number(seekable.end(index));
    if (Number.isFinite(start) && Number.isFinite(end) && local >= start && local <= end) return local;
  }
  return null;
}

export function seekHasArrived(position, target, preparing = false) {
  return !preparing && target !== null && Number.isFinite(position)
    && Math.abs(position - target) < 1.5;
}
