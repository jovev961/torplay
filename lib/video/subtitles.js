import path from "node:path";
import { analyse } from "chardet";

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const SUBTITLE_TYPES = new Map([
  [".srt", "srt"],
  [".vtt", "vtt"],
]);

const LANGUAGE_TOKENS = new Map([
  ["en", ["en", "English"]],
  ["eng", ["en", "English"]],
  ["english", ["en", "English"]],
  ["es", ["es", "Spanish"]],
  ["spa", ["es", "Spanish"]],
  ["spanish", ["es", "Spanish"]],
  ["fr", ["fr", "French"]],
  ["fre", ["fr", "French"]],
  ["fra", ["fr", "French"]],
  ["french", ["fr", "French"]],
  ["de", ["de", "German"]],
  ["deu", ["de", "German"]],
  ["ger", ["de", "German"]],
  ["german", ["de", "German"]],
  ["it", ["it", "Italian"]],
  ["ita", ["it", "Italian"]],
  ["italian", ["it", "Italian"]],
  ["pt", ["pt", "Portuguese"]],
  ["por", ["pt", "Portuguese"]],
  ["portuguese", ["pt", "Portuguese"]],
  ["mk", ["mk", "Macedonian"]],
  ["mkd", ["mk", "Macedonian"]],
  ["mac", ["mk", "Macedonian"]],
  ["macedonian", ["mk", "Macedonian"]],
  ["sr", ["sr", "Serbian"]],
  ["srp", ["sr", "Serbian"]],
  ["serbian", ["sr", "Serbian"]],
  ["hr", ["hr", "Croatian"]],
  ["hrv", ["hr", "Croatian"]],
  ["croatian", ["hr", "Croatian"]],
  ["bs", ["bs", "Bosnian"]],
  ["bos", ["bs", "Bosnian"]],
  ["bosnian", ["bs", "Bosnian"]],
  ["bg", ["bg", "Bulgarian"]],
  ["bul", ["bg", "Bulgarian"]],
  ["bulgarian", ["bg", "Bulgarian"]],
  ["ru", ["ru", "Russian"]],
  ["rus", ["ru", "Russian"]],
  ["russian", ["ru", "Russian"]],
  ["tr", ["tr", "Turkish"]],
  ["tur", ["tr", "Turkish"]],
  ["turkish", ["tr", "Turkish"]],
  ["ar", ["ar", "Arabic"]],
  ["ara", ["ar", "Arabic"]],
  ["arabic", ["ar", "Arabic"]],
]);

const QUALIFIER_TOKENS = new Set([
  ...LANGUAGE_TOKENS.keys(),
  "cc",
  "forced",
  "sdh",
  "sub",
  "subs",
  "subtitle",
  "subtitles",
]);

export class SubtitleError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "SubtitleError";
    this.status = status;
  }
}

export function classifySubtitleFile(name) {
  const extension = path.extname(typeof name === "string" ? name : "").toLowerCase();
  const format = SUBTITLE_TYPES.get(extension);
  return format ? { format, mimeType: "text/vtt; charset=utf-8" } : null;
}

function filenameTokens(name) {
  const stem = path.basename(name, path.extname(name));
  return stem.toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
}

export function subtitleMetadata(name) {
  const tokens = filenameTokens(name);
  const language = tokens.map((token) => LANGUAGE_TOKENS.get(token)).find(Boolean);
  const qualifiers = [];
  if (tokens.includes("forced")) qualifiers.push("Forced");
  if (tokens.includes("sdh")) qualifiers.push("SDH");
  if (tokens.includes("cc")) qualifiers.push("CC");

  const fallback = path.basename(name, path.extname(name)).replace(/[._-]+/g, " ").trim();
  const label = language?.[1] || fallback || "Subtitles";
  return {
    language: language?.[0] || "und",
    label: qualifiers.length ? `${label} (${qualifiers.join(", ")})` : label,
  };
}

function episodeCode(name) {
  const patterns = [
    /(?:^|[^a-z\d])s0*(\d{1,2})[\s._-]*e0*(\d{1,3})(?!\d)/i,
    /(?:^|[^a-z\d])0*(\d{1,2})[\s._-]*x[\s._-]*0*(\d{1,3})(?!\d)/i,
    /(?:^|[^a-z\d])season[\s._/\\-]*0*(\d{1,2})[\s._/\\-]*episode[\s._/\\-]*0*(\d{1,3})(?!\d)/i,
  ];
  const match = patterns.map((pattern) => pattern.exec(name)).find(Boolean);
  return match ? `s${Number(match[1])}e${Number(match[2])}` : null;
}

function normalizedStem(name) {
  return filenameTokens(name).filter((token) => !QUALIFIER_TOKENS.has(token)).join(" ");
}

export function subtitleMatchesVideo(video, subtitle, videoCount) {
  if (videoCount === 1) return true;

  const videoName = video.path || video.name || "";
  const subtitleName = subtitle.path || subtitle.name || "";
  const videoEpisode = episodeCode(videoName);
  const subtitleEpisode = episodeCode(subtitleName);
  if (videoEpisode && subtitleEpisode) return videoEpisode === subtitleEpisode;

  const sameDirectory = path.dirname(videoName) === path.dirname(subtitleName);
  return sameDirectory && normalizedStem(videoName) === normalizedStem(subtitleName);
}

const ENCODING_LABELS = new Map([
  ["UTF-8", "utf-8"],
  ["UTF-16LE", "utf-16le"],
  ["UTF-16BE", "utf-16be"],
  ["windows-1250", "windows-1250"],
  ["windows-1251", "windows-1251"],
  ["windows-1252", "windows-1252"],
  ["ISO-8859-1", "windows-1252"],
  ["ISO-8859-2", "iso-8859-2"],
  ["ISO-8859-5", "iso-8859-5"],
  ["ASCII", "windows-1252"],
]);

export function decodeSubtitle(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const candidates = analyse(bytes);
    const hasHighBytes = bytes.some((byte) => byte >= 0x80);
    let detected = candidates.find((candidate) =>
      ENCODING_LABELS.has(candidate.name) && (!hasHighBytes || candidate.name !== "ASCII")
    )?.name;
    const windows1250 = candidates.find((candidate) => candidate.name === "windows-1250");
    const detectedCandidate = candidates.find((candidate) => candidate.name === detected);
    if (
      detected === "windows-1252"
      && windows1250
      && windows1250.confidence >= detectedCandidate.confidence
    ) {
      detected = "windows-1250";
    }
    const encoding = ENCODING_LABELS.get(detected);
    if (!encoding) {
      throw new SubtitleError(`The subtitle encoding ${detected || "is unknown"} is not supported.`);
    }
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  }
}

function normalizeText(input) {
  return input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

export function subtitleToWebVtt(input, format) {
  if (!input || input.byteLength === 0) throw new SubtitleError("The subtitle file is empty.");
  if (input.byteLength > MAX_SUBTITLE_BYTES) {
    throw new SubtitleError("The subtitle file is too large.", 413);
  }

  const text = normalizeText(decodeSubtitle(input));
  if (!text || text.includes("\0")) throw new SubtitleError("The subtitle file is invalid.");

  if (format === "vtt") {
    if (!/^WEBVTT(?:\s|$)/i.test(text)) {
      throw new SubtitleError("The WebVTT file is missing its WEBVTT header.");
    }
    return `${text}\n`;
  }

  if (format !== "srt") throw new SubtitleError("This subtitle format is not supported.");
  let cueCount = 0;
  const converted = text.replace(
    /^(\d{1,2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{3})(.*)$/gm,
    (_line, start, startMs, end, endMs, settings) => {
      cueCount += 1;
      return `${start}.${startMs} --> ${end}.${endMs}${settings}`;
    },
  );
  if (cueCount === 0) throw new SubtitleError("The SubRip file contains no valid cues.");
  return `WEBVTT\n\n${converted}\n`;
}
