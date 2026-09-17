import { randomUUID } from "node:crypto";
import {
  MAX_SUBTITLE_BYTES,
  subtitleMatchesVideo,
  subtitleMetadata,
  subtitleToWebVtt,
} from "../video/subtitles.js";
import { subtitleConfig, subtitleLanguageLabel } from "./config.js";
import {
  readCachedSubtitle,
  subtitleContentHash,
  writeCachedSubtitle,
} from "./cache.js";
import {
  downloadProviderSubtitle,
  searchOpenSubtitles,
  searchSubDL,
} from "./providers.js";

function normalizeRelease(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\.[a-z\d]{2,4}$/i, "")
    .replace(/[^a-z\d]+/gi, " ")
    .trim()
    .toLowerCase();
}

function releaseScore(track, releaseName) {
  const expected = normalizeRelease(releaseName);
  const actual = normalizeRelease(track.releaseName || track.name);
  if (!expected || !actual) return 0;
  if (actual === expected) return 1;
  if (expected.includes(actual) || actual.includes(expected)) return 0.8;
  const expectedTokens = new Set(expected.split(" "));
  const tokens = actual.split(" ");
  return tokens.length ? tokens.filter((token) => expectedTokens.has(token)).length / tokens.length : 0;
}

function rankTrack(track, releaseName) {
  const sourceWeight = track.provider === "torrent" ? 40 : track.provider === "embedded" ? 30 : 20;
  return sourceWeight
    + releaseScore(track, releaseName) * 50
    + Math.min(Number(track.providerScore) || 0, 10)
    + Math.min(Math.log10((Number(track.downloads) || 0) + 1), 5)
    - (track.hearingImpaired ? 1 : 0);
}

function duplicateKey(track) {
  const release = normalizeRelease(track.releaseName);
  const name = normalizeRelease(track.name);
  if (!release && !name) return null;
  return `${track.language}\0${release}\0${name}`;
}

function consolidate(discovery) {
  const byKey = new Map();
  const result = [];
  for (const track of discovery.rawTracks) {
    const key = track.contentHash
      ? `${track.language}\0hash:${track.contentHash}`
      : duplicateKey(track);
    const existing = key && byKey.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, track.provider])];
      if (track.score > existing.score) {
        const sources = existing.sources;
        Object.assign(existing, track, { sources });
      }
      continue;
    }
    const candidate = { ...track, sources: [track.provider] };
    if (key) byKey.set(key, candidate);
    result.push(candidate);
  }
  discovery.tracks = result.sort((left, right) =>
    left.language.localeCompare(right.language)
    || right.score - left.score
    || left.label.localeCompare(right.label)
  );
}

function addTracks(discovery, tracks) {
  const enabled = new Set(discovery.preferences.enabledLanguages);
  for (const track of tracks) {
    if (!enabled.has(track.language)) continue;
    discovery.rawTracks.push({
      ...track,
      id: randomUUID(),
      label: subtitleLanguageLabel(track.language),
      score: rankTrack(track, discovery.releaseName),
    });
  }
  consolidate(discovery);
}

function publicTrack(sessionId, fileId, track) {
  return {
    id: track.id,
    language: track.language,
    label: track.label,
    source: track.provider,
    sources: track.sources,
    releaseName: track.releaseName || null,
    hearingImpaired: track.hearingImpaired,
    score: track.score,
    src: `/api/torrents/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/subtitles/${encodeURIComponent(track.id)}`,
  };
}

export function publicSubtitleDiscovery(session, fileId, discovery) {
  return {
    state: discovery.state,
    preferences: discovery.preferences,
    providers: discovery.providers,
    tracks: discovery.tracks.map((track) => publicTrack(session.id, fileId, track)),
  };
}

function torrentTracks(session, videoFile) {
  const torrent = session.resource.torrent;
  const videos = torrent.files.filter((file) => /\.(?:mp4|m4v|webm|mkv|avi|mov|wmv|mpe?g|ts|m2ts|vob|og[vm]|flv|3gp|3g2|divx|mts)$/i.test(file.name));
  return torrent.files.flatMap((file, index) => {
    if (!/\.(?:srt|vtt)$/i.test(file.name)) return [];
    if (!subtitleMatchesVideo(videoFile, file, videos.length)) return [];
    const metadata = subtitleMetadata(file.name);
    return [{
      provider: "torrent",
      providerId: String(index),
      torrentFileId: String(index),
      name: file.name,
      releaseName: file.name,
      language: metadata.language,
      hearingImpaired: /(?:^|[._ -])(?:sdh|cc)(?:[._ -]|$)/i.test(file.name),
      format: file.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
      providerScore: 0,
      downloads: 0,
    }];
  });
}

function embeddedTracks(media) {
  return (media?.subtitleStreams || []).flatMap((stream) => {
    if (!stream.textBased) return [];
    const language = String(stream.language || "und").toLowerCase().split("-")[0];
    return [{
      provider: "embedded",
      providerId: String(stream.index),
      streamIndex: stream.index,
      name: stream.title || `Embedded ${language.toUpperCase()}`,
      releaseName: "Embedded",
      language,
      hearingImpaired: Boolean(stream.hearingImpaired),
      format: "vtt",
      providerScore: 0,
      downloads: 0,
    }];
  });
}

export function getSubtitleDiscovery(session, fileId) {
  return session.subtitleDiscoveries?.get(String(fileId)) || null;
}

export function startSubtitleDiscovery(session, file, options = {}) {
  const fileId = String(session.resource.torrent.files.indexOf(file));
  session.subtitleDiscoveries ??= new Map();
  const existing = session.subtitleDiscoveries.get(fileId);
  if (existing) return existing;

  const config = options.config || subtitleConfig();
  const preferences = {
    defaultLanguage: config.defaultLanguage,
    enabledLanguages: config.enabledLanguages,
  };
  const discovery = {
    state: "loading",
    preferences,
    releaseName: session.releaseName || file.name,
    context: session.mediaContext,
    rawTracks: [],
    tracks: [],
    providers: {
      torrent: "ready",
      embedded: "loading",
      opensubtitles: config.opensubtitles.apiKey ? "loading" : "disabled",
      subdl: config.subdl.apiKey ? "loading" : "disabled",
    },
  };
  session.subtitleDiscoveries.set(fileId, discovery);
  addTracks(discovery, torrentTracks(session, file));

  const tasks = [];
  tasks.push(Promise.resolve().then(async () => {
    try {
      const media = await options.probeMedia(file);
      discovery.media = media;
      addTracks(discovery, embeddedTracks(media));
      discovery.providers.embedded = "ready";
    } catch {
      discovery.providers.embedded = "failed";
    }
  }));

  if (session.mediaContext?.tmdbId) {
    const searches = [
      ["opensubtitles", () => searchOpenSubtitles(
        session.mediaContext,
        config.enabledLanguages,
        config.opensubtitles,
        options.fetchImpl,
      )],
      ["subdl", () => searchSubDL(
        session.mediaContext,
        config.enabledLanguages,
        config.subdl,
        options.fetchImpl,
      )],
    ];
    for (const [provider, search] of searches) {
      if (discovery.providers[provider] === "disabled") continue;
      tasks.push(Promise.resolve().then(async () => {
        try {
          const result = await search();
          addTracks(discovery, result.tracks);
          discovery.providers[provider] = result.status;
        } catch {
          discovery.providers[provider] = "failed";
        }
      }));
    }
  } else {
    if (discovery.providers.opensubtitles === "loading") discovery.providers.opensubtitles = "disabled";
    if (discovery.providers.subdl === "loading") discovery.providers.subdl = "disabled";
  }

  discovery.done = Promise.allSettled(tasks).then(() => {
    discovery.state = "ready";
    return discovery;
  });
  return discovery;
}

async function torrentSubtitleBody(session, track) {
  const file = session.resource.torrent.files[Number(track.torrentFileId)];
  if (!file || file.length > MAX_SUBTITLE_BYTES) throw new Error("Subtitle file is unavailable.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return subtitleToWebVtt(bytes, track.format);
}

export async function loadSubtitleTrack(session, fileId, trackId, options = {}) {
  const discovery = getSubtitleDiscovery(session, fileId);
  const track = discovery?.tracks.find((candidate) => candidate.id === trackId)
    || discovery?.rawTracks.find((candidate) => candidate.id === trackId);
  if (!track) return null;

  let body;
  if (track.provider === "torrent") {
    body = await torrentSubtitleBody(session, track);
  } else {
    const context = discovery.context;
    body = context ? await readCachedSubtitle(context, track.provider, track.providerId) : null;
    if (!body) {
      if (track.provider === "embedded") {
        body = await options.extractEmbedded(discovery.media, track.streamIndex);
      } else {
        body = await downloadProviderSubtitle(track, options.config || subtitleConfig(), options.fetchImpl);
      }
      if (context) await writeCachedSubtitle(context, track.provider, track.providerId, body);
    }
  }

  const rawTrack = discovery.rawTracks.find((candidate) => candidate.id === trackId);
  if (rawTrack) rawTrack.contentHash = subtitleContentHash(body);
  consolidate(discovery);
  return { body, track };
}
