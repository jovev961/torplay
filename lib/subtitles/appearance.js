export const SUBTITLE_APPEARANCE_STORAGE_KEY = "torplay:subtitle-appearance:v1";

export const SUBTITLE_APPEARANCE_DEFAULTS = Object.freeze({
  version: 1,
  size: "medium",
  font: "sans",
  textColor: "white",
  edgeStyle: "shadow",
  backgroundOpacity: 75,
  bottomOffsetPercent: 10,
});

export const SUBTITLE_APPEARANCE_OPTIONS = Object.freeze({
  size: Object.freeze(["small", "medium", "large", "extra-large"]),
  font: Object.freeze(["sans", "serif", "monospace"]),
  textColor: Object.freeze(["white", "yellow", "cyan"]),
  edgeStyle: Object.freeze(["none", "shadow", "outline"]),
  backgroundOpacity: Object.freeze([0, 25, 50, 75, 100]),
  bottomOffsetPercent: Object.freeze([5, 10, 15, 20, 25, 30, 35]),
});

function allowed(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}

export function normalizeSubtitleAppearance(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    version: 1,
    size: allowed(input.size, SUBTITLE_APPEARANCE_OPTIONS.size, SUBTITLE_APPEARANCE_DEFAULTS.size),
    font: allowed(input.font, SUBTITLE_APPEARANCE_OPTIONS.font, SUBTITLE_APPEARANCE_DEFAULTS.font),
    textColor: allowed(
      input.textColor,
      SUBTITLE_APPEARANCE_OPTIONS.textColor,
      SUBTITLE_APPEARANCE_DEFAULTS.textColor,
    ),
    edgeStyle: allowed(
      input.edgeStyle,
      SUBTITLE_APPEARANCE_OPTIONS.edgeStyle,
      SUBTITLE_APPEARANCE_DEFAULTS.edgeStyle,
    ),
    backgroundOpacity: allowed(
      Number(input.backgroundOpacity),
      SUBTITLE_APPEARANCE_OPTIONS.backgroundOpacity,
      SUBTITLE_APPEARANCE_DEFAULTS.backgroundOpacity,
    ),
    bottomOffsetPercent: allowed(
      Number(input.bottomOffsetPercent),
      SUBTITLE_APPEARANCE_OPTIONS.bottomOffsetPercent,
      SUBTITLE_APPEARANCE_DEFAULTS.bottomOffsetPercent,
    ),
  };
}

export function readSubtitleAppearance(storage) {
  try {
    const raw = storage?.getItem(SUBTITLE_APPEARANCE_STORAGE_KEY);
    return normalizeSubtitleAppearance(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...SUBTITLE_APPEARANCE_DEFAULTS };
  }
}

export function writeSubtitleAppearance(storage, value) {
  const normalized = normalizeSubtitleAppearance(value);
  try {
    storage?.setItem(SUBTITLE_APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Playback and the in-memory preference remain usable when storage is unavailable.
  }
  return normalized;
}

export function subtitleAppearanceClassName(value) {
  const appearance = normalizeSubtitleAppearance(value);
  return [
    `subtitle-size-${appearance.size}`,
    `subtitle-font-${appearance.font}`,
    `subtitle-color-${appearance.textColor}`,
    `subtitle-edge-${appearance.edgeStyle}`,
    `subtitle-background-${appearance.backgroundOpacity}`,
  ].join(" ");
}

export function applySubtitleCuePosition(track, bottomOffsetPercent) {
  const offset = allowed(
    Number(bottomOffsetPercent),
    SUBTITLE_APPEARANCE_OPTIONS.bottomOffsetPercent,
    SUBTITLE_APPEARANCE_DEFAULTS.bottomOffsetPercent,
  );
  const cues = Array.from(track?.cues || []);
  let positioned = 0;
  for (const cue of cues) {
    if (!("line" in cue)) continue;
    try {
      cue.snapToLines = false;
      cue.line = 100 - offset;
      if ("lineAlign" in cue) cue.lineAlign = "end";
      positioned += 1;
    } catch {
      // Some older engines expose partial VTTCue setters. Native placement remains the fallback.
    }
  }
  return positioned;
}
