export function automaticSubtitleId(tracks, defaultLanguage) {
  return tracks.find((track) => track.language === defaultLanguage)?.id || null;
}

export function applyAutomaticSubtitle(selection, discovery) {
  if (selection.mode === "user") return selection;
  return {
    mode: "automatic",
    activeId: automaticSubtitleId(discovery.tracks, discovery.preferences.defaultLanguage),
  };
}
