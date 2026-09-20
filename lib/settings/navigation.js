export const SETTINGS_SECTIONS = Object.freeze([
  ["general", "General"],
  ["services", "Services"],
  ["torrent-sources", "Torrent Sources"],
  ["subtitles", "Subtitles"],
  ["playback", "Playback"],
  ["about", "About"],
]);

export function settingsSectionFromHash(hash) {
  const id = String(hash || "").replace(/^#/, "");
  return SETTINGS_SECTIONS.some(([sectionId]) => sectionId === id) ? id : "general";
}

export function settingsValidationRequest(snapshot, section) {
  if (!snapshot) return { providerIds: [], native: false };
  if (section === "services" || section === "subtitles") {
    return {
      providerIds: snapshot.providers
        .filter((provider) => provider.section === section)
        .map((provider) => provider.id),
      native: false,
    };
  }
  if (section === "torrent-sources") {
    return {
      providerIds: snapshot.torrentSources.providers
        .filter((provider) => provider.enabled)
        .map((provider) => provider.id),
      native: true,
    };
  }
  return { providerIds: [], native: false };
}
