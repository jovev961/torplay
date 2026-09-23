import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { parse } from "yaml";
import { safeRequest, classifyRequestFailure } from "./cardigann/http.js";
import { definitionCapabilities, importDefinition } from "./cardigann/definition.js";

const API = "https://api.github.com/repos/Prowlarr/Indexers/git/trees/";
const TTL = 15 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const ACCESS = new Set(["public", "semi-private", "private"]);

async function archiveMetadata(body, ids) {
  const wanted = new Set(ids);
  const found = new Set();
  const metadata = new Map();
  const extract = tar.extract();
  const reading = pipeline(Readable.from([body]), createGunzip(), extract);
  let entries = 0;
  let unpackedBytes = 0;
  try {
    for await (const entry of extract) {
      const { name, type, size } = entry.header;
      entries += 1;
      unpackedBytes += size;
      if (entries > 10_000 || unpackedBytes > 64 * 1024 * 1024) throw failure("The community definition archive is too large.");
      const id = name.match(/^[^/]+\/definitions\/v11\/(.+\.ya?ml)$/i)?.[1];
      if (type !== "file" || !wanted.has(id) || size > 256 * 1024) {
        entry.resume();
        continue;
      }
      found.add(id);
      const chunks = [];
      for await (const chunk of entry) chunks.push(chunk);
      let definition;
      try { definition = parse(Buffer.concat(chunks).toString("utf8"), { maxAliasCount: 20 }); }
      catch { continue; }
      if (!definition || typeof definition !== "object") continue;
      try {
        const categories = definitionCapabilities(definition);
        metadata.set(id, {
          definitionId: typeof definition.id === "string" ? definition.id : null,
          mediaTypes: categories.mediaTypes,
          anime: categories.categories.some((name) => /(^|\/)Anime(\/|$)/i.test(name)),
          access: ACCESS.has(definition.type) ? definition.type : null,
          language: typeof definition.language === "string" ? definition.language : null,
          requiresFlareSolverr: Array.isArray(definition.settings)
            && definition.settings.some((setting) => setting?.type === "info_flaresolverr"),
        });
      } catch { /* A malformed definition is not listed as compatible. */ }
    }
    await reading;
  } catch {
    extract.destroy();
    await reading.catch(() => {});
    throw failure("The community definition archive could not be read. Try again later or use Advanced setup.");
  }
  if (found.size !== wanted.size || metadata.size === 0) throw failure("The community definition archive is incomplete or contains no usable sources.");
  return metadata;
}

// The factory keeps tests isolated. No directory traffic occurs until list() is called.
export function createCommunityDirectory({ request = safeRequest, now = Date.now, importer = importDefinition } = {}) {
  let snapshot;
  let pending;

  async function json(url) {
    let response;
    try {
      response = await request(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "TorPlay" },
        protocols: ["https:"], timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024,
      });
    } catch (error) { throw classifyRequestFailure(error); }
    if ([403, 429].includes(response.status)) throw failure("The community directory is unavailable or rate limited. Try again later or use Advanced setup.", 503);
    if (response.status !== 200) throw failure("The community directory could not be loaded. Try again or use Advanced setup.");
    let data;
    try { data = JSON.parse(response.body.toString("utf8")); } catch { throw failure("The community directory returned an invalid response."); }
    return data;
  }

  async function tree(ref) {
    const data = await json(`${API}${ref}`);
    if (!SHA.test(data?.sha) || !Array.isArray(data.tree) || data.truncated !== false) {
      throw failure("The community directory is incomplete or invalid. Try again or use Advanced setup.");
    }
    if (data.tree.some((entry) => typeof entry.path !== "string" || !entry.path || /[/\\\0]/.test(entry.path)
      || [".", ".."].includes(entry.path) || !SHA.test(entry.sha))) throw failure("The community directory contains invalid entries.");
    return data;
  }

  async function load() {
    const commit = await json("https://api.github.com/repos/Prowlarr/Indexers/commits/master");
    if (!SHA.test(commit?.sha)) throw failure("The community directory revision is invalid.");
    const root = await tree(commit.sha);
    let directory = root;
    for (const name of ["definitions", "v11"]) {
      const entry = directory.tree.find((item) => item.path === name && item.type === "tree" && item.mode === "040000");
      if (!entry) throw failure("The community definition directory could not be found.");
      directory = await tree(entry.sha);
    }
    const entries = [];
    let count = 0;
    async function collect(data, prefix = "") {
      if (++count > 40) throw failure("The community directory exceeds the supported size.");
      for (const item of data.tree) {
        const id = `${prefix}${item.path}`;
        if (item.type === "tree" && item.mode === "040000") await collect(await tree(item.sha), `${id}/`);
        else if (item.type === "blob" && ["100644", "100755"].includes(item.mode) && /\.ya?ml$/i.test(item.path)) {
          entries.push({ id, name: item.path.replace(/\.ya?ml$/i, "").replace(/[-_]+/g, " ") });
          if (entries.length > 10_000) throw failure("The community directory exceeds the supported size.");
        }
      }
    }
    await collect(directory);
    entries.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
    let archive;
    try {
      archive = await request(`https://codeload.github.com/Prowlarr/Indexers/tar.gz/${commit.sha}`, {
        protocols: ["https:"], timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024,
      });
    } catch (error) { throw classifyRequestFailure(error); }
    if (archive.status !== 200) throw failure("The community definition archive could not be loaded. Try again or use Advanced setup.");
    const metadata = await archiveMetadata(archive.body, entries.map((item) => item.id));
    snapshot = { revision: commit.sha, entries: entries.filter((item) => metadata.get(item.id)?.mediaTypes.length)
      .map((item) => ({ ...item, ...metadata.get(item.id) })), expiresAt: now() + TTL };
    return snapshot;
  }

  return {
    async list({ refresh = false } = {}) {
      if (pending) return pending;
      if (!refresh && snapshot?.expiresAt > now()) return snapshot;
      pending = load().finally(() => { pending = null; });
      return pending;
    },
    async importEntry({ id, revision } = {}) {
      if (!snapshot || snapshot.expiresAt <= now() || revision !== snapshot.revision) {
        throw failure("This community list has expired or changed. Refresh it and choose the source again.", 409);
      }
      const entry = snapshot.entries.find((item) => item.id === id);
      if (!entry) throw failure("Choose a source from the community list.", 400);
      const path = entry.id.split("/").map(encodeURIComponent).join("/");
      return importer(`https://raw.githubusercontent.com/Prowlarr/Indexers/${snapshot.revision}/definitions/v11/${path}`);
    },
  };
}

const key = Symbol.for("torplay.communityDirectory.v3");
globalThis[key] ??= createCommunityDirectory();
export const communityDirectory = globalThis[key];
