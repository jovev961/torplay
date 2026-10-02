import { search } from "../../../lib/sources/discovery.js";
import { mediaContext } from "../../../lib/sources/contract.js";
import { pendingCandidates, inspectCandidates } from "../../../lib/torrent/source-inspection.js";
import { findUsenetSources } from "../../../lib/usenet/search.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function number(params, key, { zero = false } = {}) {
  const value = params.get(key);
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (zero ? 0 : 1)) throw Object.assign(new Error("Invalid search media context."), { status: 400 });
  return parsed;
}

function flag(params, key) {
  const value = params.get(key);
  if (value === null) return false;
  if (value !== "1") throw Object.assign(new Error("Search flags must be 1 when provided."), { status: 400 });
  return true;
}

async function discoverAndInspect(context, options, emit) {
  const found = await search(context, { ...options, onUpdate: (update) => {
    emit?.({ type: "results", results: pendingCandidates(update.candidates), cache: update.cache });
    emit?.({ type: "diagnostics", diagnostics: update.diagnostics });
  } });
  const results = await inspectCandidates(found.candidates, context, { signal: options.signal,
    onUpdate: (rows) => emit?.({ type: "results", results: rows, cache: found.cache }) });
  return { results, diagnostics: found.diagnostics, cache: found.cache };
}

function safeError(error) {
  const known = ["INVALID_SEARCH", "NO_TORRENT_SOURCES", "SOURCES_UNAVAILABLE", "CONFIGURATION_REQUIRED"].includes(error?.code);
  return { error: known ? error.message : "Search could not be completed.", code: known ? error.code : "SEARCH_FAILED",
    ...(Array.isArray(error?.diagnostics) ? { diagnostics: error.diagnostics } : {}) };
}

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const type = params.get("type") || "generic";
    const context = mediaContext({ title: params.get("q"), type,
      originalTitle: params.get("originalTitle"), tmdbId: number(params, "tmdbId"),
      imdbId: params.get("imdbId"), year: number(params, "year", { zero: true }),
      season: type === "show" ? number(params, "season", { zero: true }) : null,
      episode: type === "show" ? number(params, "episode") : null });
    const options = { cacheOnly: flag(params, "cacheOnly"), refresh: flag(params, "refresh") };
    if (options.cacheOnly && options.refresh) return Response.json({ error: "Cache-only search cannot refresh sources." }, { status: 400 });
    request.signal.throwIfAborted();
    if (request.headers.get("accept")?.includes("application/x-ndjson")) return progressive(request, context, options);
    const [torrent, usenet] = await Promise.allSettled([
      discoverAndInspect(context, { ...options, signal: request.signal }),
      options.cacheOnly ? Promise.resolve([]) : findUsenetSources(context, { signal: request.signal }),
    ]);
    request.signal.throwIfAborted();
    const usenetResults = usenet.status === "fulfilled" ? usenet.value : [];
    if (torrent.status === "rejected" && !usenetResults.length) throw torrent.reason;
    return Response.json({ ...(torrent.status === "fulfilled" ? torrent.value : { results: [], diagnostics: torrent.reason?.diagnostics || [] }), usenetResults },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(safeError(error), { status: Number.isInteger(error?.status) ? error.status : 502 });
  }
}

function progressive(request, context, options) {
  const cancellation = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event) => {
        if (!closed && !cancellation.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const abort = () => cancellation.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      emit({ type: "started" });
      void Promise.allSettled([
        discoverAndInspect(context, { ...options, signal: cancellation.signal }, emit),
        (options.cacheOnly ? Promise.resolve([]) : findUsenetSources(context, { signal: cancellation.signal })).then((results) => {
          emit({ type: "usenet", results });
          return results;
        }),
      ]).then(([torrent, usenet]) => {
        if (cancellation.signal.aborted) return;
        if (torrent.status === "rejected") {
          emit({ type: "diagnostics", diagnostics: torrent.reason?.diagnostics || [] });
          if (usenet.status === "rejected" || !usenet.value.length) emit({ type: "error", ...safeError(torrent.reason) });
        }
        emit({ type: "complete" });
      }).catch(() => {
        if (!cancellation.signal.aborted) emit({ type: "error", error: "Search could not be completed.", code: "SEARCH_FAILED" });
      }).finally(() => {
        request.signal.removeEventListener("abort", abort);
        if (!closed) { closed = true; try { controller.close(); } catch { /* Reader cancelled. */ } }
      });
    },
    cancel() { closed = true; cancellation.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
