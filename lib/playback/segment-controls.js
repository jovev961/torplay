export function activeSkipSegment(position, segments) {
  if (!Number.isFinite(position) || !segments) return null;
  return ["recap", "intro"]
    .map((type) => segments[type] ? { type, ...segments[type] } : null)
    .filter((segment) => segment && position >= segment.start && position < segment.end)
    .sort((left, right) => left.start - right.start)[0] || null;
}
