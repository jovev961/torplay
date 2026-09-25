export function clampSeekTarget(target, duration) {
  const position = Number(target);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(duration, position));
}

export function skipTarget(position, pendingTarget, seconds, duration) {
  return clampSeekTarget((pendingTarget ?? position) + seconds, duration);
}

export function seekHasArrived(position, target, preparing = false) {
  return !preparing && target !== null && Number.isFinite(position)
    && Math.abs(position - target) < 1.5;
}
