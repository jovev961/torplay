export const SETTINGS_SECTIONS = Object.freeze([
  ["general", "Overview"],
  ["services", "Services"],
  ["torrent-sources", "Video Sources"],
  ["subtitles", "Subtitles"],
  ["playback", "Playback"],
  ["about", "About"],
]);

export function settingsSectionFromHash(hash) {
  const id = String(hash || "").replace(/^#/, "");
  return SETTINGS_SECTIONS.some(([sectionId]) => sectionId === id) ? id : "general";
}

export function settingsValidationRequest(snapshot, section) {
  if (!snapshot) return { providerIds: [] };
  if (section === "services" || section === "subtitles") {
    return {
      providerIds: snapshot.providers
        .filter((provider) => provider.section === section)
        .map((provider) => provider.id),
    };
  }
  return { providerIds: [] };
}
