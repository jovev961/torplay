import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  getActiveConversion,
  getVideoFile,
} from "../../../../../../../../lib/torrent/manager.js";
import { parseByteRange } from "../../../../../../../../lib/video/range.js";
import { hlsAssetExists } from "../../../../../../../../lib/video/transcode.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HLS_ASSET_PATTERN = /^(?:index\.m3u8|segment-\d{5}\.ts)$/;

async function respond(request, context, includeBody) {
  const { id, fileId, asset } = await context.params;
  if (!HLS_ASSET_PATTERN.test(asset)) {
    return Response.json({ code: "INVALID_ASSET", error: "Invalid HLS asset." }, { status: 400 });
  }

  const match = getVideoFile(id, fileId);
  if (!match) {
    return Response.json({ code: "NOT_FOUND", error: "Playable video file not found." }, { status: 404 });
  }
  const job = getActiveConversion(match.session, match.file);
  if (!job) {
    return Response.json({ code: "NOT_PREPARED", error: "Playback has not been prepared." }, { status: 404 });
  }
  const requestedJob = new URL(request.url).searchParams.get("job");
  if (!requestedJob || requestedJob !== job.id) {
    return Response.json({ code: "OBSOLETE_HLS_JOB", error: "This playback job is no longer active." }, { status: 409 });
  }
  if (!(await hlsAssetExists(job, asset))) {
    const error = job.error;
    return Response.json(
      {
        code: error?.code || "HLS_ASSET_PENDING",
        error: error?.message || "The requested HLS segment is not available yet.",
      },
      { status: error ? error.status : 404 },
    );
  }

  job.touch();
  const assetPath = path.join(job.outputDirectory, asset);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": asset.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t",
  });
  if (asset.endsWith(".m3u8")) {
    const source = await readFile(assetPath, "utf8");
    const manifest = Buffer.from(source.replace(
      /^(segment-\d{5}\.ts)$/gm,
      `$1?job=${encodeURIComponent(job.id)}`,
    ));
    headers.set("Content-Length", String(manifest.length));
    return new Response(includeBody ? manifest : null, { headers });
  }

  const details = await stat(assetPath);
  const range = parseByteRange(request.headers.get("range"), details.size);
  if (range.error) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${details.size}` },
    });
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range.end - range.start + 1));
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${details.size}`);
  }
  const status = range.partial ? 206 : 200;
  if (!includeBody) return new Response(null, { status, headers });
  const stream = createReadStream(assetPath, { start: range.start, end: range.end });
  return new Response(Readable.toWeb(stream), { status, headers });
}

export function GET(request, context) {
  return respond(request, context, true);
}

export function HEAD(request, context) {
  return respond(request, context, false);
}
