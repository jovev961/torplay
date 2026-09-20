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
