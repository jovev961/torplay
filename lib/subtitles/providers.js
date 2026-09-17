import path from "node:path";
import { MAX_SUBTITLE_BYTES, subtitleToWebVtt } from "../video/subtitles.js";

const PROVIDER_TIMEOUT_MS = 12_000;
const LANGUAGE_ALIASES = new Map([
  ["english", "en"], ["eng", "en"],
  ["macedonian", "mk"], ["mkd", "mk"], ["mac", "mk"],
  ["serbian", "sr"], ["srp", "sr"],
  ["croatian", "hr"], ["hrv", "hr"],
  ["bosnian", "bs"], ["bos", "bs"],
]);

export class SubtitleProviderError extends Error {
  constructor(provider, message, status = 502) {
    super(message);
    this.name = "SubtitleProviderError";
    this.provider = provider;
    this.status = status;
  }
}

function languageCode(value) {
  const normalized = String(value || "und").trim().toLowerCase().replace("_", "-");
  return LANGUAGE_ALIASES.get(normalized) || normalized.split("-")[0];
}

function extensionFormat(name, fallback = "srt") {
  const extension = path.extname(String(name || "")).toLowerCase();
  if (extension === ".vtt") return "vtt";
  if (extension === ".srt") return "srt";
  return fallback;
}

async function providerJson(url, options, provider, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error?.name === "TimeoutError"
      ? `${provider} timed out.`
      : `${provider} could not be reached.`;
    throw new SubtitleProviderError(provider, message, error?.name === "TimeoutError" ? 504 : 502);
  }
  if (!response.ok) {
    throw new SubtitleProviderError(provider, `${provider} returned HTTP ${response.status}.`, 502);
  }
  try {
    return await response.json();
  } catch {
    throw new SubtitleProviderError(provider, `${provider} returned invalid JSON.`, 502);
  }
}

function commonSearchParams(context, languages) {
  const params = new URLSearchParams({
    tmdb_id: String(context.tmdbId),
    languages: languages.join(","),
  });
  if (context.type === "show") {
    params.set("season_number", String(context.season));
    params.set("episode_number", String(context.episode));
  }
  return params;
}

export async function searchOpenSubtitles(context, languages, config, fetchImpl = fetch) {
  if (!config.apiKey) return { status: "disabled", tracks: [] };
  const params = commonSearchParams(context, languages);
  const data = await providerJson(
    `https://api.opensubtitles.com/api/v1/subtitles?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Api-Key": config.apiKey,
        "User-Agent": config.userAgent,
      },
    },
    "OpenSubtitles",
    fetchImpl,
  );

  const tracks = (Array.isArray(data?.data) ? data.data : []).flatMap((entry) => {
    const attributes = entry?.attributes || {};
    const files = Array.isArray(attributes.files) ? attributes.files : [];
    return files.flatMap((file) => {
      if (!file?.file_id) return [];
      return [{
        provider: "opensubtitles",
        providerId: String(file.file_id),
        language: languageCode(attributes.language),
        name: file.file_name || attributes.release || "OpenSubtitles subtitle",
        releaseName: attributes.release || file.file_name || "",
        hearingImpaired: Boolean(attributes.hearing_impaired),
        format: extensionFormat(file.file_name),
        providerScore: Number(attributes.ratings) || 0,
        downloads: Number(attributes.download_count) || 0,
        downloadRef: { fileId: file.file_id },
      }];
    });
  });
  return { status: "ready", tracks };
}

function subdlTracks(data, context) {
  const subtitles = Array.isArray(data?.subtitles) ? data.subtitles : [];
  return subtitles.flatMap((subtitle) => {
    const unpacked = Array.isArray(subtitle.unpack_files) && subtitle.unpack_files.length
      ? subtitle.unpack_files
      : [subtitle];
    return unpacked.flatMap((file) => {
      const season = Number(file.season ?? subtitle.season);
      const episode = Number(file.episode ?? subtitle.episode);
      if (context.type === "show" && (
        (Number.isFinite(season) && season !== Number(context.season))
        || (Number.isFinite(episode) && episode !== Number(context.episode))
      )) return [];
      const providerId = file.file_n_id || file.n_id || subtitle.n_id || subtitle.id;
      if (!providerId) return [];
      return [{
        provider: "subdl",
        providerId: String(providerId),
        language: languageCode(file.language || file.lang || subtitle.language || subtitle.lang),
        name: file.name || subtitle.name || "SubDL subtitle",
        releaseName: file.release_name || subtitle.release_name || "",
        hearingImpaired: Boolean(file.hi ?? subtitle.hi),
        format: extensionFormat(file.name || subtitle.name, file.format || subtitle.format || "srt"),
        providerScore: Number(file.match_score ?? subtitle.match_score) || 0,
        downloads: Number(file.downloads ?? subtitle.downloads) || 0,
        downloadRef: {
          nId: String(subtitle.n_id || subtitle.id || providerId),
          directUrl: file.url || subtitle.url || null,
        },
      }];
    });
  });
}

export async function searchSubDL(context, languages, config, fetchImpl = fetch) {
  if (!config.apiKey) return { status: "disabled", tracks: [] };
  const params = new URLSearchParams({
    tmdb_id: String(context.tmdbId),
    type: context.type === "show" ? "tv" : "movie",
    languages: languages.join(","),
    unpack: "1",
  });
  if (context.type === "show") {
    params.set("season", String(context.season));
    params.set("episode", String(context.episode));
  }
  const data = await providerJson(
    `https://api.subdl.com/api/v2/subtitles/search?${params}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${config.apiKey}` } },
    "SubDL",
    fetchImpl,
  );
  return { status: "ready", tracks: subdlTracks(data, context) };
}

function trustedDownloadUrl(value, provider) {
  let url;
  try {
    url = new URL(value, provider === "subdl" ? "https://dl.subdl.com" : undefined);
  } catch {
    throw new SubtitleProviderError(provider, `${provider} returned an invalid download URL.`);
  }
  const expected = provider === "subdl" ? "subdl.com" : "opensubtitles.com";
  if (url.protocol !== "https:" || !(url.hostname === expected || url.hostname.endsWith(`.${expected}`))) {
    throw new SubtitleProviderError(provider, `${provider} returned an unsafe download URL.`);
  }
  return url;
}

async function limitedBytes(response, provider) {
  if (!response.ok) throw new SubtitleProviderError(provider, `${provider} download returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SUBTITLE_BYTES) {
    throw new SubtitleProviderError(provider, `${provider} subtitle is too large.`, 413);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SUBTITLE_BYTES) {
    throw new SubtitleProviderError(provider, `${provider} subtitle is too large.`, 413);
  }
  return bytes;
}

export async function downloadProviderSubtitle(track, config, fetchImpl = fetch) {
  let url;
  let headers = {};
  if (track.provider === "opensubtitles") {
    const data = await providerJson(
      "https://api.opensubtitles.com/api/v1/download",
      {
        method: "POST",
        headers: {
          "Api-Key": config.opensubtitles.apiKey,
          "User-Agent": config.opensubtitles.userAgent,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: Number(track.downloadRef.fileId) }),
      },
      "OpenSubtitles",
      fetchImpl,
    );
    url = trustedDownloadUrl(data.link, "opensubtitles");
  } else if (track.provider === "subdl") {
    url = track.downloadRef.directUrl
      ? trustedDownloadUrl(track.downloadRef.directUrl, "subdl")
      : new URL(`https://api.subdl.com/api/v2/subtitles/${encodeURIComponent(track.downloadRef.nId)}/download?format=file`);
    headers = { Authorization: `Bearer ${config.subdl.apiKey}` };
  } else {
    throw new SubtitleProviderError(track.provider, "Unknown subtitle provider.");
  }

  const response = await fetchImpl(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    const link = data.link || data.url || data.download_url;
    if (!link) throw new SubtitleProviderError(track.provider, `${track.provider} did not return a subtitle file.`);
    const download = await fetchImpl(trustedDownloadUrl(link, track.provider), {
      headers,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return subtitleToWebVtt(await limitedBytes(download, track.provider), track.format);
  }
  return subtitleToWebVtt(await limitedBytes(response, track.provider), track.format);
}
