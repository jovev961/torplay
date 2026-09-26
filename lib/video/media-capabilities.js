const BADGE_LABELS = Object.freeze({
  "dolby-vision": "Dolby Vision",
  "hdr10-plus": "HDR10+",
  hdr10: "HDR10",
  hdr: "HDR",
  atmos: "Atmos",
  truehd: "TrueHD",
  eac3: "EAC3 / DD+",
  ac3: "AC3 / Dolby Digital",
  hevc: "HEVC / H.265",
});

function outputBadgeIds(plan) {
  const output = plan?.output;
  if (!output) return [];
  const ids = [];
  const hdrId = output.hdrFormat === "dolby-vision" ? "dolby-vision"
    : output.hdrFormat === "hdr10-plus" ? "hdr10-plus"
      : output.hdrFormat === "hdr10" ? "hdr10"
        : ["hdr", "hlg"].includes(output.hdrFormat) ? "hdr" : null;
  if (hdrId) ids.push(hdrId);
  if (output.videoCodec === "hevc") ids.push("hevc");
  if (["truehd", "eac3", "ac3"].includes(output.audioCodec)) ids.push(output.audioCodec);
  return ids;
}

function badge(id, verification) {
  return { id, label: BADGE_LABELS[id], verification };
}

export function inferMediaBadges(value) {
  const source = String(value || "");
  const found = [];
  const add = (id, pattern) => {
    if (pattern.test(source)) found.push(badge(id, "inferred"));
  };

  add("dolby-vision", /(?:^|[^a-z\d])(?:dolby[ ._-]*vision|dovi|do[ ._-]*vi|dv)(?![a-z\d])/i);
  add("hdr10-plus", /(?:^|[^a-z\d])hdr[ ._-]*10(?:\+|[ ._-]*plus)(?![a-z\d])/i);
  if (!found.some((entry) => entry.id === "hdr10-plus")) {
    add("hdr10", /(?:^|[^a-z\d])hdr[ ._-]*10(?![a-z\d+])/i);
  }
  if (!found.some((entry) => entry.id === "hdr10-plus" || entry.id === "hdr10")) {
    add("hdr", /(?:^|[^a-z\d])hdr(?![a-z\d])/i);
  }
  add("hevc", /(?:^|[^a-z\d])(?:hevc|h[ ._-]*265|x265)(?![a-z\d])/i);
  add("atmos", /(?:^|[^a-z\d])atmos(?![a-z\d])/i);
  add("truehd", /(?:^|[^a-z\d])true[ ._-]*hd(?![a-z\d])/i);
  add("eac3", /(?:^|[^a-z\d])(?:e[ ._-]*ac[ ._-]*3|ddp(?:lus)?(?:\d(?:\.\d+)?)?|dd\+)(?![a-z\d])/i);
  add("ac3", /(?:^|[^a-z\d])(?:ac[ ._-]*3|dolby[ ._-]*digital)(?![ ._-]*plus)(?![a-z\d])/i);
  return found;
}

function selectedAudio(media, selectedAudioStreamIndex) {
  const tracks = Array.isArray(media?.audioStreams) ? media.audioStreams : [];
  if (selectedAudioStreamIndex !== null && selectedAudioStreamIndex !== undefined) {
    return tracks.find((track) => track.index === Number(selectedAudioStreamIndex)) || null;
  }
  return tracks.find((track) => track.default) || tracks[0] || null;
}

export function verifiedMediaBadges(media, selectedAudioStreamIndex = null) {
  const ids = [];
  const video = media?.video || {};
  if (video.dolbyVision) ids.push("dolby-vision");
  if (video.hdrFormat === "hdr10-plus") ids.push("hdr10-plus");
  else if (video.hdrFormat === "hdr10") ids.push("hdr10");
  else if (video.hdrFormat === "hlg" || video.hdrFormat === "hdr") ids.push("hdr");
  if (media?.videoCodec === "hevc") ids.push("hevc");

  const audio = selectedAudio(media, selectedAudioStreamIndex);
  if (audio?.atmos === true) ids.push("atmos");
  if (audio?.codec === "truehd") ids.push("truehd");
  else if (audio?.codec === "eac3") ids.push("eac3");
  else if (audio?.codec === "ac3") ids.push("ac3");
  return [...new Set(ids)].map((id) => badge(id, "verified"));
}

export function playbackMediaBadges(media, playbackPlan = null) {
  const sourceBadges = Array.isArray(media?.badges) ? media.badges : [];
  const activeIds = new Set(outputBadgeIds(playbackPlan));
  const audioPreserved = playbackPlan?.audioAction === "copy";
  if (audioPreserved && sourceBadges.some((entry) => entry.id === "atmos")) {
    activeIds.add("atmos");
  }
  const prepared = Boolean(playbackPlan?.output);
  const result = sourceBadges.map((entry) => ({
    ...entry,
    playbackStatus: activeIds.has(entry.id) ? "active" : "inactive",
    statusLabel: activeIds.has(entry.id)
      ? `${entry.label} is active during playback`
      : prepared
        ? `${entry.label} is present in the source but is not active during playback`
        : `${entry.label} is present in the source; start playback to determine support`,
  }));
  const sourceIds = new Set(sourceBadges.map((entry) => entry.id));
  for (const id of activeIds) {
    if (sourceIds.has(id) || !BADGE_LABELS[id]) continue;
    result.push({
      ...badge(id, "output"),
      playbackStatus: "active",
      statusLabel: `${BADGE_LABELS[id]} is active during playback`,
    });
  }
  return result;
}

export function normalizeCapabilityStatus(value) {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

export function capabilityAllows(value, allowUnknown = true) {
  const status = normalizeCapabilityStatus(value);
  return status === "supported" || (allowUnknown && status === "unknown");
}

export function codecLabel(codec) {
  const labels = { h264: "H.264", hevc: "HEVC", aac: "AAC", ac3: "AC3",
    eac3: "EAC3", truehd: "TrueHD" };
  return labels[codec] || String(codec || "Unknown").toUpperCase();
}
