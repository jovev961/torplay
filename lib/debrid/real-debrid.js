import path from "node:path";
import { DebridError, providerRequest, requireData } from "./http.js";

const API = "https://api.real-debrid.com/rest/1.0/";
const OAUTH = "https://api.real-debrid.com/oauth/v2/";
const PUBLIC_CLIENT_ID = "X245A4XAIBGVM";
const DEVICE_GRANT = "http://oauth.net/grant_type/device/1.0";

function form(values) {
  return new URLSearchParams(values);
}

export async function startRealDebridAuthorization(fetchImpl = globalThis.fetch) {
  const data = await providerRequest(OAUTH,
    `device/code?client_id=${PUBLIC_CLIENT_ID}&new_credentials=yes`,
    { fetchImpl });
  return requireData(data, (value) => typeof value.device_code === "string"
    && typeof value.user_code === "string" && Number.isFinite(value.interval)
    && Number.isFinite(value.expires_in));
}

export async function finishRealDebridAuthorization(deviceCode, fetchImpl = globalThis.fetch) {
  const credentials = await providerRequest(OAUTH,
    `device/credentials?client_id=${PUBLIC_CLIENT_ID}&code=${encodeURIComponent(deviceCode)}`,
    { fetchImpl });
  requireData(credentials, (value) => typeof value.client_id === "string"
    && typeof value.client_secret === "string");
  const tokens = await providerRequest(OAUTH, "token", {
    method: "POST", fetchImpl,
    body: form({
      client_id: credentials.client_id, client_secret: credentials.client_secret,
      code: deviceCode, grant_type: DEVICE_GRANT,
    }),
  });
  requireData(tokens, (value) => typeof value.access_token === "string"
    && typeof value.refresh_token === "string");
  return {
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + Math.max(0, Number(tokens.expires_in) - 60) * 1000,
  };
}

export class RealDebridProvider {
  constructor(credentials, { fetchImpl = globalThis.fetch, onRefresh = async () => {} } = {}) {
    this.id = "real-debrid";
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.onRefresh = onRefresh;
  }

  async refresh() {
    const credentials = this.credentials;
    const tokens = await providerRequest(OAUTH, "token", {
      method: "POST", fetchImpl: this.fetchImpl,
      body: form({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: credentials.refreshToken,
        grant_type: DEVICE_GRANT,
      }),
    });
    requireData(tokens, (value) => typeof value.access_token === "string"
      && typeof value.refresh_token === "string");
    this.credentials = {
      ...credentials,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Math.max(0, Number(tokens.expires_in) - 60) * 1000,
    };
    await this.onRefresh(this.credentials);
  }

  async request(endpoint, options = {}) {
    if (Date.now() >= (this.credentials.expiresAt || 0)) await this.refresh();
    try {
      return await providerRequest(API, endpoint, {
        ...options, token: this.credentials.accessToken, fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error.code !== "authentication") throw error;
      await this.refresh();
      return providerRequest(API, endpoint, {
        ...options, token: this.credentials.accessToken, fetchImpl: this.fetchImpl,
      });
    }
  }

  async getAccountInfo() {
    const user = await this.request("user");
    return requireData(user, (value) => typeof value.id !== "undefined");
  }

  async testConnection() {
    await this.getAccountInfo();
    return { status: "connected" };
  }

  async checkAvailability(torrent) {
    // Real-Debrid's current documented API has no global cache lookup. Only
    // already-completed account resources qualify for cached-only playback.
    for (let page = 1; page <= 5; page += 1) {
      const list = await this.request(`torrents?limit=500&page=${page}`);
      requireData(list, Array.isArray);
      const match = list.find((item) => String(item.hash || "").toLowerCase() === torrent.infoHash
        && item.status === "downloaded");
      if (match) {
        const info = await this.request(`torrents/info/${encodeURIComponent(match.id)}`);
        requireData(info, (value) => Array.isArray(value.files) && Array.isArray(value.links));
        const selected = info.files.filter((file) => file.selected === 1);
        return {
          status: selected.length && info.links.length ? "available" : "miss",
          resource: { id: match.id, owned: false, links: info.links },
          files: selected.map((file) => ({
            providerId: String(file.id), name: path.posix.basename(file.path),
            path: String(file.path || "").replace(/^\/+/, ""), size: file.bytes,
          })),
        };
      }
      if (list.length < 500) break;
    }
    return { status: "miss" };
  }

  async resolveStream(_torrent, selection, availability) {
    const resource = availability.resource;
    if (!resource || !availability.files.some((file) => file.providerId === selection.providerId)) {
      throw new DebridError("file-not-found", "The requested file is unavailable.");
    }
    // Link order is not treated as authoritative: unrestriction metadata must
    // identify the requested file before a URL is used.
    for (const link of resource.links) {
      const result = await this.request("unrestrict/link", {
        method: "POST", body: form({ link }),
      });
      const name = path.posix.basename(String(result?.filename || ""));
      if (name === selection.name && Number(result.filesize) === Number(selection.size)
        && typeof result.download === "string") {
        return { url: result.download, resource };
      }
    }
    throw new DebridError("file-not-found", "The requested Real-Debrid file link is unavailable.");
  }

  async cleanup() {
    // Existing account resources are never deleted by TorPlay.
  }

  async disconnect() {
    await this.request("disable_access_token", { raw: true }).catch(() => {});
  }
}
