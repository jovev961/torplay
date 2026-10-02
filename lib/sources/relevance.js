import { infoHash } from "./contract.js";

export function releaseText(value) {
  return String(value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "")
    .replace(/^(?:\s*\[[^\]]+\]\s*)+/, "").replace(/&/g, " and ")
    .replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

const RELEASE_SUFFIX = /^(?:\d{4}\b|s\d+\b|s\d+(?:e\d+)+\b|\d+x\d+\b|season\b|episode\b|complete\b|pack\b|\d{3,4}p\b|4k\b|8k\b|uhd\b|blu\s*ray\b|brrip\b|bdrip\b|web\b|webrip\b|webdl\b|hdtv\b|dvdrip\b|remux\b|x26[45]\b|h26[45]\b|hevc\b|avc\b|av1\b|hdr\b|dv\b|aac\b|dts\b|ddp?\b|proper\b|repack\b|multi\b|dual\b|subbed\b|dubbed\b|extended\b|unrated\b|directors\s+cut\b)/;

function titleMatch(title, alias) {
  const release = releaseText(title).replace(/^(?:a|an|the)\s+/, "");
  const query = releaseText(alias).replace(/^(?:a|an|the)\s+/, "");
  if (!query) return false;
  if (release === query) return true;
  return release.startsWith(`${query} `) && RELEASE_SUFFIX.test(release.slice(query.length + 1));
}

function episodeMatch(candidate, context) {
  const media = candidate.media || {};
  if (media.season != null && media.season !== context.season) return null;
  if (media.episode != null && media.episode > 0 && media.episode !== context.episode) return null;
  const title = candidate.title;
  const episodes = [...title.matchAll(/(?:^|[^a-z\d])s(\d+)((?:[\s._-]*e\d+)+)|(?:^|[^\d])(\d+)[\s._-]*x[\s._-]*(\d+)|season[\s._-]*(\d+)[\s._-]*episode[\s._-]*(\d+)/gi)];
  if (episodes.length) return episodes.some((match) => {
    const season = Number(match[1] ?? match[3] ?? match[5]);
    const listed = match[2] ? [...match[2].matchAll(/e(\d+)/gi)].map((episode) => Number(episode[1]))
      : [Number(match[4] ?? match[6])];
    return season === context.season && listed.includes(context.episode);
  }) ? 0 : null;
  if (media.season === context.season && media.episode === context.episode) return 0;
  const seasons = [...title.matchAll(/(?:^|[^a-z\d])s(\d+)(?!\d)|season[\s._-]*(\d+)(?!\d)/gi)];
  if (seasons.length) return seasons.some((match) => Number(match[1] ?? match[2]) === context.season) ? 1 : null;
  if (media.season === context.season && !media.episode) return 1;
  // Missing episode metadata is not itself a contradiction.
  return 2;
}

function relevance(candidate, context) {
  if (context.type === "generic") return 0;
  const media = candidate.media || {};
  if (media.type && media.type !== context.type) return null;
  if (media.imdbId && context.imdbId && media.imdbId !== context.imdbId) return null;
  if (media.tmdbId && context.tmdbId && media.tmdbId !== context.tmdbId) return null;
  if (context.type === "movie" && media.year && context.year && media.year !== context.year) return null;
  const identityMatches = (media.imdbId && media.imdbId === context.imdbId)
    || (media.tmdbId && media.tmdbId === context.tmdbId);
  if (!identityMatches && !(context.aliases || [context.title]).some((alias) => titleMatch(candidate.title, alias))) return null;
  if (context.type === "movie" && /(?:^|[^a-z\d])s\d+[\s._-]*e\d+/i.test(candidate.title)) return null;
  if (context.type === "movie" && context.year) {
    const release = releaseText(candidate.title).replace(/^(?:a|an|the)\s+/, "");
    const suffix = (context.aliases || [context.title]).map((alias) => releaseText(alias).replace(/^(?:a|an|the)\s+/, ""))
      .filter((alias) => release.startsWith(`${alias} `)).map((alias) => release.slice(alias.length + 1))[0];
    const year = suffix?.match(/^((?:19|20)\d{2})(?!\d)/)?.[1];
    if (year && Number(year) !== context.year) return null;
  }
  return context.type === "show" ? episodeMatch(candidate, context) : 0;
}

export function candidateKey(candidate) {
  if (candidate.kind === "nzb") return `nzb:${candidate.indexerId}:${candidate.guid || candidate.nzbUrl}`;
  const hash = infoHash(candidate.infoHash);
  if (hash) return `torrent:${hash}`;
  // Unknown size is insufficient evidence to merge separate releases.
  return candidate.size > 0 ? `torrent:${releaseText(candidate.title)}:${candidate.size}`
    : `torrent:${candidate.sourceId}:${candidate.locator?.downloadUrl || candidate.title}`;
}

export function rankCandidates(candidates, context) {
  const ranked = candidates.map((candidate) => ({ candidate, match: relevance(candidate, context) }))
    .filter((item) => item.match !== null).sort((a, b) => a.match - b.match
      || (b.candidate.seeders ?? 0) - (a.candidate.seeders ?? 0)
      || (a.candidate.size > 0 ? a.candidate.size : Infinity) - (b.candidate.size > 0 ? b.candidate.size : Infinity)
      || a.candidate.title.localeCompare(b.candidate.title, "en")
      || String(a.candidate.sourceId || a.candidate.indexerId).localeCompare(String(b.candidate.sourceId || b.candidate.indexerId), "en"));
  const seen = new Set();
  return ranked.flatMap(({ candidate }) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate];
  });
}
