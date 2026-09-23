function firstHeaderValue(value) {
  return String(value || "").split(",")[0].trim();
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function configuredPort(value, fallback) {
  const port = Number(String(value ?? "").trim() || fallback);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

function requestOrigin(request) {
  const url = new URL(request.url);
  const protocol = firstHeaderValue(request.headers.get("x-forwarded-proto")) || url.protocol.replace(":", "");
  const host = firstHeaderValue(request.headers.get("x-forwarded-host"))
    || firstHeaderValue(request.headers.get("host"))
    || url.host;
  if (!new Set(["http", "https"]).has(protocol)) return url.origin;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

export function remotePlaybackOrigin(request, environment = {}) {
  const origin = requestOrigin(request);
  if (environment.TORPLAY_DISTRIBUTION === "linux-appimage") return origin;
  const current = new URL(origin);
  if (!isLoopbackHostname(current.hostname)) return origin;

  const configuredHostname = String(environment.TORPLAY_PUBLIC_HOSTNAME || "").trim().toLowerCase();
  if (!configuredHostname && environment.NODE_ENV !== "production") return origin;
  const hostname = configuredHostname || "torplay.local";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(hostname)) return origin;
  const port = configuredPort(environment.TORPLAY_PUBLIC_PORT, 80);
  return `http://${hostname}${port === 80 ? "" : `:${port}`}`;
}

export function absoluteRemoteMediaUrl(origin, pathname) {
  const base = new URL(origin);
  if (!new Set(["http:", "https:"]).has(base.protocol)) {
    throw new Error("Remote playback requires an HTTP media origin.");
  }
  return new URL(pathname, `${base.origin}/`).toString();
}

export function remotePlaybackSource({
  origin,
  sessionId,
  mediaPath,
  contentType,
  title,
  posterUrl = null,
  duration = 0,
  originSeconds = 0,
  receiverStartTime = 0,
  mode = "direct",
  subtitles = [],
  activeSubtitleId = null,
}) {
  return {
    sessionId,
    url: absoluteRemoteMediaUrl(origin, mediaPath),
    contentType,
    title,
    posterUrl,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    originSeconds: Number.isFinite(originSeconds) && originSeconds > 0 ? originSeconds : 0,
    receiverStartTime: Number.isFinite(receiverStartTime) && receiverStartTime > 0 ? receiverStartTime : 0,
    mode: mode === "hls" ? "hls" : "direct",
    subtitles: subtitles.map((track) => ({
      id: track.id,
      label: track.label,
      language: track.language,
      url: absoluteRemoteMediaUrl(origin, track.src),
    })),
    activeSubtitleId,
  };
}
