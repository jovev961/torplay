import path from "node:path";
import { DebridError } from "../debrid/http.js";

const API = "https://api.torbox.app/v1/api/";

export function normalizeTorBoxJob(job) {
  if (!job || !Number.isInteger(Number(job.id))) throw new DebridError("malformed-response", "TorBox returned an invalid Usenet job.");
  const raw = String(job.download_state || "").toLowerCase();
  const state = job.download_finished && Array.isArray(job.files) ? "ready"
    : /error|fail|missing|incomplete|password/i.test(raw) ? "failed"
      : /cancel|delet/i.test(raw) ? "cancelled"
        : /repair|unpack|extract|process|post/i.test(raw) ? "processing"
          : /download/i.test(raw) ? "downloading" : "queued";
  const progress = Number(job.progress);
  return {
    id: Number(job.id), status: state,
    progress: Number.isFinite(progress) && progress >= 0 && progress <= 1 ? progress : null,
    message: state === "failed" ? "TorBox could not prepare this NZB." : null,
    files: state === "ready" ? job.files.map((file) => ({
      providerId: String(file.id),
      name: path.posix.basename(String(file.name || file.short_name || "")),
      path: String(file.name || file.short_name || "").replace(/^\/+/, ""),
      size: Number(file.size),
    })).filter((file) => /^\d+$/.test(file.providerId) && Number.isSafeInteger(file.size) && file.size > 0) : [],
  };
}

export class TorBoxUsenet {
  constructor(apiKey, { fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(new URL(endpoint, API), {
        method: options.method || "GET", body: options.body,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...options.headers },
        cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs || 8_000),
      });
    } catch { throw new DebridError("unavailable", "TorBox is unavailable."); }
    let result;
    try { result = await response.json(); }
    catch { throw new DebridError("malformed-response", "TorBox returned invalid data."); }
    if (!response.ok || result?.success !== true || !("data" in result)) {
      const code = result?.error === "PLAN_RESTRICTED_FEATURE" ? "usenet-unavailable"
        : result?.error === "DUPLICATE_ITEM" ? "duplicate"
          : response.status === 429 ? "rate-limited"
            : response.status === 401 || response.status === 403 ? "authentication" : "provider-error";
      throw new DebridError(code, code === "usenet-unavailable"
        ? "Usenet is unavailable on this TorBox account." : "TorBox could not process the NZB.",
      code === "rate-limited" ? 429 : 422);
    }
    return result.data;
  }

  async capability() {
    try {
      await this.request("usenet/mylist?limit=1");
      return "available";
    } catch (error) {
      if (error.code === "usenet-unavailable") return "unavailable";
      return "unknown";
    }
  }

  async create(buffer) {
    const body = new FormData();
    body.set("file", new Blob([buffer], { type: "application/x-nzb" }), "upload.nzb");
    const result = await this.request("usenet/createusenetdownload", { method: "POST", body, timeoutMs: 20_000 });
    const id = Number(result?.usenetdownload_id ?? result?.usenet_id ?? result?.id);
    if (!Number.isSafeInteger(id) || id < 0) throw new DebridError("malformed-response", "TorBox did not return a Usenet job ID.");
    return id;
  }

  async get(id) {
    const result = await this.request(`usenet/mylist?id=${encodeURIComponent(id)}`);
    return normalizeTorBoxJob(Array.isArray(result) ? result.find((item) => Number(item.id) === Number(id)) : result);
  }

  async resolveStream(job, file) {
    const params = new URLSearchParams({ token: this.apiKey, usenet_id: String(job.id), file_id: String(file.providerId) });
    const url = await this.request(`usenet/requestdl?${params}`);
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new DebridError("malformed-response", "TorBox did not return a media URL.");
    }
    return { url, resource: null };
  }

  async delete(id) {
    await this.request("usenet/controlusenetdownload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usenet_id: String(id), operation: "delete", all: false }),
    });
  }
}
