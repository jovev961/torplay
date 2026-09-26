export function activeSkipSegment(position, segments) {
  if (!Number.isFinite(position) || !segments) return null;
  const positionMs = position * 1000;
  return ["recap", "intro"]
    .map((type) => segments[type] ? { type, ...segments[type] } : null)
    .filter((segment) => segment && positionMs >= segment.startMs && positionMs < segment.endMs)
    .sort((left, right) => left.startMs - right.startMs)[0] || null;
}

export function automaticSegment(segment) {
  return segment?.source === "skipdb";
}

export function showManualSkip(segment, autoSkipEnabled) {
  return Boolean(segment) && (!autoSkipEnabled || !automaticSegment(segment));
}

export function segmentPlaybackRange(segment) {
  return segment ? { start: segment.startMs / 1000, end: segment.endMs / 1000 } : null;
}
