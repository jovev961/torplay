import path from "node:path";
import { DebridError, providerRequest, requireData } from "./http.js";

const API = "https://api.torbox.app/v1/api/";

function data(value) {
  requireData(value, (item) => item && item.success === true && "data" in item);
  return value.data;
}

export async function startTorBoxAuthorization(fetchImpl = globalThis.fetch) {
  return data(await providerRequest(API, "user/auth/device/start?app=TorPlay", { fetchImpl }));
}

export async function finishTorBoxAuthorization(deviceCode, fetchImpl = globalThis.fetch) {
  const result = data(await providerRequest(API, "user/auth/device/token", {
    method: "POST", body: JSON.stringify({ device_code: deviceCode }),
    headers: { "Content-Type": "application/json" }, fetchImpl,
  }));
  const token = typeof result === "string" ? result : result?.access_token;
  return requireData(token, (value) => typeof value === "string" && value.length > 10);
}

export class TorBoxProvider {
  constructor(credentials, { fetchImpl = globalThis.fetch } = {}) {
    this.id = "torbox";
    this.token = credentials.apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, options = {}) {
    return data(await providerRequest(API, endpoint, {
      ...options, token: this.token, fetchImpl: this.fetchImpl,
    }));
  }

  async getAccountInfo() {
    return requireData(await this.request("user/me?settings=false"),
      (value) => typeof value?.id !== "undefined");
  }

  async testConnection() {
    await this.getAccountInfo();
    return { status: "connected" };
  }

  async listResources(offset = 0, limit = 100, fresh = false) {
    const result = await this.request(`torrents/mylist?offset=${offset}&limit=${limit}${fresh ? "&bypass_cache=true" : ""}`);
    return requireData(result, Array.isArray);
  }

  async getResource(id, fresh = true) {
    const result = await this.request(`torrents/mylist?id=${encodeURIComponent(id)}${fresh ? "&bypass_cache=true" : ""}`);
    return requireData(result, (value) => value && typeof value === "object" && !Array.isArray(value));
  }

  async submit(magnet) {
    const payload = new FormData();
    payload.set("magnet", magnet);
    const created = await this.request("torrents/createtorrent", { method: "POST", body: payload });
    return requireData(created, (value) => Number.isInteger(value?.torrent_id)).torrent_id;
  }

  async deleteResource(id) {
    await this.request("torrents/controltorrent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ torrent_id: Number(id), operation: "delete", all: false }),
    });
  }

  async checkAvailability(torrent) {
    const result = await this.request(`torrents/checkcached?hash=${torrent.infoHash}&format=object&list_files=true`);
    const cached = result?.[torrent.infoHash] || result?.[torrent.infoHash.toUpperCase()];
    if (!cached) return { status: "miss" };
    requireData(cached, (value) => Array.isArray(value.files));
    return {
      status: cached.files.length ? "available" : "miss",
      files: cached.files.map((file) => ({
        providerId: String(file.id),
        name: path.posix.basename(String(file.name || file.short_name || "")),
        path: String(file.name || file.short_name || "").replace(/^\/+/, ""),
        size: file.size,
      })),
    };
  }

  async findExisting(infoHash) {
    for (let offset = 0; offset < 100_000; offset += 1_000) {
      const list = await this.listResources(offset, 1000, true);
      const match = list.find((item) => String(item.hash || "").toLowerCase() === infoHash
        && item.download_present === true && item.download_finished === true);
      if (match) return match;
      if (list.length < 1_000) return null;
    }
    throw new DebridError("account-scan-incomplete", "Could not finish checking TorBox account torrents.", 503);
  }

  async resolveStream(torrent, selection, availability = null) {
    let resource = availability?.resource?.id
      ? await this.getResource(availability.resource.id) : await this.findExisting(torrent.infoHash);
    let owned = false;
    try {
      if (!resource) {
        const payload = new FormData();
        payload.set("magnet", torrent.magnet || `magnet:?xt=urn:btih:${torrent.infoHash}`);
        payload.set("add_only_if_cached", "true");
        const created = await this.request("torrents/createtorrent", { method: "POST", body: payload });
        requireData(created, (value) => Number.isInteger(value?.torrent_id));
        owned = true;
        resource = { id: created.torrent_id };
        for (let attempt = 0; attempt < 5; attempt += 1) {
          resource = await this.request(`torrents/mylist?id=${created.torrent_id}&bypass_cache=true`);
          if (resource?.download_present && resource?.download_finished && Array.isArray(resource.files)) break;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      requireData(resource, (value) => Number.isInteger(value?.id) && Array.isArray(value.files)
        && value.download_present === true && value.download_finished === true);
      const matches = resource.files.filter((file) =>
        path.posix.basename(String(file.name || file.short_name || "")) === selection.name
        && Number(file.size) === Number(selection.size));
      if (matches.length !== 1 || !Number.isInteger(matches[0].id)) {
        throw new DebridError("file-not-found", "The requested TorBox file is unavailable.");
      }
      // Official requestdl requires token in its query. It is sent only from
      // this server to TorBox, never returned to a browser or included in logs.
      const params = new URLSearchParams({
        token: this.token, torrent_id: String(resource.id), file_id: String(matches[0].id),
      });
      const url = data(await providerRequest(API, `torrents/requestdl?${params}`, {
        fetchImpl: this.fetchImpl,
      }));
      requireData(url, (value) => typeof value === "string" && value.startsWith("https://"));
      return { url, resource: { id: resource.id, owned } };
    } catch (error) {
      throw error;
    }
  }

  async cleanup(resource) {
    // Account resources are retained until the user explicitly deletes them.
    void resource;
  }
}
