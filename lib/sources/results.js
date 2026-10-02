import { randomUUID } from "node:crypto";
import parseTorrent from "parse-torrent";
import { request, endpointUrl, withDeadline } from "../network/request.js";
import { SourceError, magnetSource } from "./contract.js";

const stateKey = Symbol.for("torplay.sources.privateResults");
const TTL = 10 * 60_000;
const MAX_RESULTS = 10_000;
const MAX_METADATA = 5 * 1024 * 1024;
function store() { return globalThis[stateKey] ??= new Map(); }
function expire() {
  const records = store();
  for (const [id, record] of records) if (record.expiresAt <= Date.now()) records.delete(id);
  return records;
}

async function download(url, serviceOrigin, signal) {
  const parsed = endpointUrl(url, { protocols: ["http:", "https:"] });
  const configured = serviceOrigin && parsed.origin === serviceOrigin;
  const response = await request(parsed, { signal, timeoutMs: 15_000, maxBytes: MAX_METADATA,
    protocols: ["http:", "https:"], policy: configured ? "configured-service" : "external", sameOrigin: Boolean(configured) });
  if (response.status !== 200) throw new SourceError("INVALID_RESPONSE", "Torrent metadata could not be downloaded.");
  return response.body;
}

async function validatedResolution(raw, serviceOrigin, signal) {
  if (!raw || typeof raw !== "object") throw new SourceError("INVALID_RESPONSE", "The source did not resolve torrent metadata.");
  if (raw.downloadUrl) raw = { torrentInput: await download(raw.downloadUrl, serviceOrigin, signal) };
  if (raw.torrentInput) {
    if (!Buffer.isBuffer(raw.torrentInput) || !raw.torrentInput.length || raw.torrentInput.length > MAX_METADATA) {
      throw new SourceError("INVALID_RESPONSE", "The source returned invalid torrent metadata.");
    }
    let metadata;
    try { metadata = await parseTorrent(raw.torrentInput); }
    catch { throw new SourceError("INVALID_RESPONSE", "The source returned invalid torrent metadata."); }
    if (!metadata?.infoHash) throw new SourceError("INVALID_RESPONSE", "The source returned invalid torrent metadata.");
    return { torrentInput: raw.torrentInput, infoHash: metadata.infoHash.toLowerCase() };
  }
  const magnet = magnetSource(raw.magnet, raw.infoHash);
  if (!magnet.magnet) throw new SourceError("INVALID_RESPONSE", "The source returned an invalid magnet.");
  return magnet;
}

export function rememberTorrent(candidate, context) {
  const records = expire();
  while (records.size >= MAX_RESULTS) records.delete(records.keys().next().value);
  const locator = candidate.locator;
  const descriptor = { kind: "torrent", magnet: locator.magnet, infoHash: candidate.infoHash,
    releaseName: candidate.title, mediaContext: context.tmdbId ? context : null,
    resolver: locator.resolve || locator.downloadUrl ? ({ signal } = {}) => withDeadline(async (boundedSignal) => {
      const raw = locator.resolve ? await locator.resolve({ signal: boundedSignal })
        : { torrentInput: await download(locator.downloadUrl, locator.serviceOrigin, boundedSignal) };
      boundedSignal.throwIfAborted();
      return validatedResolution(raw, locator.serviceOrigin, boundedSignal);
    }, { signal, timeoutMs: 30_000 }) : null };
  const id = randomUUID();
  records.set(id, { descriptor, expiresAt: Date.now() + TTL });
  return id;
}

export function rememberNzb(candidate, context) {
  const url = endpointUrl(candidate.nzbUrl);
  const records = expire();
  while (records.size >= MAX_RESULTS) records.delete(records.keys().next().value);
  if (!candidate.indexerId) throw new SourceError("INVALID_RESPONSE", "The NZB result has no configured indexer.");
  const id = randomUUID();
  records.set(id, { expiresAt: Date.now() + TTL, descriptor: { kind: "nzb", indexerId: candidate.indexerId,
    nzbUrl: url.href, title: candidate.title, mediaContext: context.tmdbId ? context : null } });
  return id;
}

export function resolve(resultId, expectedKind) {
  if (!["torrent", "nzb"].includes(expectedKind) || typeof resultId !== "string") return null;
  const record = expire().get(resultId);
  return record?.descriptor.kind === expectedKind ? record.descriptor : null;
}
