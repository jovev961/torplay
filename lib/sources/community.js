import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { request } from "../network/request.js";
import { parseDefinition, importDefinition } from "./cardigann/definition.js";
import { SourceError } from "./contract.js";

const stateKey = Symbol.for("torplay.sources.community");
const SHA = /^[a-f\d]{40}$/;
function state() { return globalThis[stateKey] ??= { snapshot: null, pending: null }; }

async function remote(url, options) {
  const response = await request(url, { signal: options.signal, headers: { Accept: "application/vnd.github+json", "User-Agent": "TorPlay" },
    timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 });
  if (response.status !== 200) throw new SourceError("COMMUNITY_UNAVAILABLE", "The community definition directory is unavailable. Try again later.", 502);
  return response.body;
}

async function loadDirectory(options) {
  let commit, tree;
  try {
    commit = JSON.parse((await remote("https://api.github.com/repos/Prowlarr/Indexers/commits/master", options)).toString("utf8"));
    if (!SHA.test(commit.sha)) throw new Error();
    tree = JSON.parse((await remote(`https://api.github.com/repos/Prowlarr/Indexers/git/trees/${commit.sha}?recursive=1`, options)).toString("utf8"));
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof SourceError) throw error;
    throw new SourceError("COMMUNITY_INVALID", "The community definition directory is incomplete or invalid.", 502);
  }
  const paths = new Set(tree.tree.filter((entry) => entry.type === "blob" && /^definitions\/v11\/(?:[^/]+\/)*[^/]+\.ya?ml$/i.test(entry.path)
    && !entry.path.split("/").some((part) => [".", ".."].includes(part) || /[\\\0]/.test(part)))
    .map((entry) => entry.path));
  if (!paths.size || paths.size > 10_000) throw new SourceError("COMMUNITY_INVALID", "The community directory has an unsupported size.", 502);
  const archive = await remote(`https://codeload.github.com/Prowlarr/Indexers/tar.gz/${commit.sha}`, options);
  const extract = tar.extract();
  const reading = pipeline(Readable.from([archive]), createGunzip(), extract, { signal: options.signal });
  void reading.catch(() => {});
  const entries = [];
  let total = 0, count = 0;
  try {
    for await (const entry of extract) {
      options.signal?.throwIfAborted();
      total += entry.header.size;
      if (++count > 10_000 || total > 64 * 1024 * 1024) throw new Error();
      const filename = entry.header.name.replace(/^[^/]+\//, "");
      if (entry.header.type !== "file" || !paths.has(filename) || entry.header.size > 256 * 1024) { entry.resume(); continue; }
      const chunks = [];
      for await (const chunk of entry) chunks.push(chunk);
      try {
        const parsed = parseDefinition(Buffer.concat(chunks).toString("utf8"), { allowUnsupported: true });
        if (!parsed.capabilities.mediaTypes.length) continue;
        entries.push({ id: filename.slice("definitions/v11/".length), name: parsed.definition.name,
          definitionId: parsed.definition.id, access: parsed.definition.type, language: parsed.definition.language,
          mediaTypes: parsed.capabilities.mediaTypes, anime: parsed.capabilities.categories.some((category) => /(^|\/)Anime(\/|$)/i.test(category)),
          requiresFlareSolverr: parsed.definition.settings?.some((field) => field.type === "info_flaresolverr") || false,
          compatibility: parsed.compatibility.supported ? "supported" : "unsupported" });
      } catch { /* Invalid definitions are omitted. Compatibility is separate from verification. */ }
    }
    await reading;
  } catch {
    extract.destroy();
    await reading.catch(() => {});
    options.signal?.throwIfAborted();
    throw new SourceError("COMMUNITY_INVALID", "The community archive could not be processed safely.", 502);
  }
  if (!entries.length) throw new SourceError("COMMUNITY_INVALID", "The community archive contains no usable definitions.", 502);
  const snapshot = { revision: commit.sha, entries: entries.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en")), expiresAt: Date.now() + 15 * 60_000 };
  state().snapshot = snapshot;
  return snapshot;
}

export const communityDirectory = {
  async list(options = {}) {
    const current = state();
    if (!options.refresh && current.snapshot?.expiresAt > Date.now()) return current.snapshot;
    if (current.pending) return current.pending;
    current.pending = loadDirectory(options).finally(() => { current.pending = null; });
    return current.pending;
  },
  async importEntry({ id, revision } = {}, options = {}) {
    const snapshot = state().snapshot;
    if (!snapshot || snapshot.expiresAt <= Date.now() || revision !== snapshot.revision) throw new SourceError("COMMUNITY_EXPIRED", "Refresh the community list and choose the source again.", 409);
    if (!snapshot.entries.some((entry) => entry.id === id)) throw new SourceError("COMMUNITY_INVALID", "Choose a source from the community list.", 400);
    const filename = id.split("/").map(encodeURIComponent).join("/");
    return importDefinition(`https://raw.githubusercontent.com/Prowlarr/Indexers/${revision}/definitions/v11/${filename}`, options);
  },
};
