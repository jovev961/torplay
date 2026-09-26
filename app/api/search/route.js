import { findAuthorizedSources, findAuthorizedSourcesProgressive } from "../../../lib/search/service.js";
import { searchContext } from "../../../lib/search/processing.js";
import { findUsenetSources } from "../../../lib/usenet/search.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalInteger(value, label, { allowZero = false } = {}) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw Object.assign(new Error(`${label} must be a valid integer.`), { status: 400 });
  }
  return parsed;
}

function optionalFlag(value, label) {
  if (value === null || value === "") return false;
  if (value !== "1") {
    throw Object.assign(new Error(`${label} must be 1 when provided.`), { status: 400 });
  }
  return true;
}

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const cacheOnly = optionalFlag(params.get("cacheOnly"), "cacheOnly");
    const refresh = optionalFlag(params.get("refresh"), "refresh");
    if (cacheOnly && refresh) {
      return Response.json({ error: "Cache-only search cannot also refresh providers." }, { status: 400 });
    }
    const query = params.get("q");
    const options = {
      type: params.get("type") || "generic",
      season: params.get("season"),
      episode: params.get("episode"),
    };
    const mediaContext = {
      type: options.type,
      tmdbId: optionalInteger(params.get("tmdbId"), "TMDB ID"),
      imdbId: params.get("imdbId") || null,
      title: query,
      originalTitle: options.type === "movie" ? params.get("originalTitle") : null,
      year: optionalInteger(params.get("year"), "Year", { allowZero: true }),
      season: options.type === "show" ? optionalInteger(options.season, "Season", { allowZero: true }) : null,
      episode: options.type === "show" ? optionalInteger(options.episode, "Episode") : null,
    };
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      searchContext(mediaContext);
      return progressiveResponse(request, mediaContext, { cacheOnly, refresh });
    }
    const [torrents, usenet] = await Promise.allSettled([
      findAuthorizedSources(mediaContext, { cacheOnly, refresh }),
      cacheOnly ? Promise.resolve([]) : findUsenetSources(mediaContext),
    ]);
    if (torrents.status === "rejected" && usenet.status === "rejected") throw torrents.reason;
    const results = torrents.status === "fulfilled" ? torrents.value : [];
    const usenetResults = usenet.status === "fulfilled" ? usenet.value : [];
    if (!results.length && !usenetResults.length && torrents.status === "rejected") throw torrents.reason;
    return Response.json({ results, usenetResults }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error.message || "Search failed.";
    const status = Number.isInteger(error.status) ? error.status : 502;
    return Response.json({ error: message, ...(error.code ? { code: error.code } : {}) }, { status });
  }
}

function progressiveResponse(request, mediaContext, searchOptions = {}) {
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const emit = (event) => {
        if (!closed && !cancellation.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const abort = () => cancellation.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      emit({ type: "started" });
      const started = performance.now();
      let firstResultLogged = false;
      void Promise.allSettled([
        findAuthorizedSourcesProgressive(mediaContext, {
          cacheOnly: searchOptions.cacheOnly,
          refresh: searchOptions.refresh,
          signal: cancellation.signal,
          onResults: (results, cache) => {
            if (!firstResultLogged && results.length) {
              firstResultLogged = true;
              console.info("[torrent-search-timing] first-result", Math.round(performance.now() - started));
            }
            emit({ type: "results", results, cache });
          },
          onTiming: ({ providerId, phase, elapsedMs }) => {
            console.info("[torrent-search-timing]", providerId || "all", phase, elapsedMs);
          },
        }),
        (searchOptions.cacheOnly ? Promise.resolve([])
          : findUsenetSources(mediaContext, { signal: cancellation.signal })).then((results) => {
          emit({ type: "usenet", results });
          return results;
        }),
      ]).then(([torrents, usenet]) => {
        if (cancellation.signal.aborted) return;
        const results = torrents.status === "fulfilled" ? torrents.value : [];
        const usenetResults = usenet.status === "fulfilled" ? usenet.value : [];
        if (!results.length && !usenetResults.length && torrents.status === "rejected") {
          const error = torrents.reason;
          emit({ type: "error", error: error?.message || "Search failed.", code: error?.code || null });
        }
        console.info("[torrent-search-timing] complete", Math.round(performance.now() - started));
        emit({ type: "complete" });
      }).finally(() => {
        request.signal.removeEventListener("abort", abort);
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* The reader may have cancelled the stream. */ }
        }
      });
    },
    cancel() { cancellation.abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  } });
}
