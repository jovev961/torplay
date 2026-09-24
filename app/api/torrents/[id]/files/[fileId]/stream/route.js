import {
  beginStream,
  bufferVideoFile,
} from "../../../../../../../lib/torrent/manager.js";
import { getPlaybackVideoFile, resolveRemoteUrl } from "../../../../../../../lib/debrid/session.js";
import { proxyRemoteFile } from "../../../../../../../lib/debrid/stream.js";
import { parseByteRange } from "../../../../../../../lib/video/range.js";
import {
  remoteMediaOptionsResponse,
  withRemoteMediaCors,
} from "../../../../../../../lib/remote-playback/cors.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function respond(request, context, includeBody) {
  const { id, fileId } = await context.params;
  const match = getPlaybackVideoFile(id, fileId);
  if (!match) {
    return Response.json({ error: "Playable video file not found." }, { status: 404 });
  }

  return streamVideoFile(request, match, includeBody);
}

export async function streamVideoFile(request, match, includeBody = true) {
  if (match.playbackMode === "transcode") {
    return Response.json(
      {
        code: "HLS_REQUIRED",
        error: "This video must be prepared through the playback endpoint.",
      },
      { status: 409 },
    );
  }
  if (match.backend === "debrid") {
    if (!includeBody) {
      try {
        return await proxyRemoteFile(new Request(request.url, {
          method: "HEAD", headers: request.headers, signal: request.signal,
        }), match.file, (force, previousUrl) => resolveRemoteUrl(
          match.session, match.file, force, previousUrl));
      } catch (error) {
        return Response.json({
          code: error.code || "REMOTE_STREAM_UNAVAILABLE",
          error: error.message || "The remote stream is unavailable.",
        }, { status: error.status || 502 });
      }
    }
    const finish = beginStream(match.session);
    const controller = new AbortController();
    match.session.activeControllers.add(controller);
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const method = includeBody ? "GET" : "HEAD";
    const proxyRequest = new Request(request.url, {
      method, headers: request.headers, signal: controller.signal,
    });
    try {
      const response = await proxyRemoteFile(proxyRequest, match.file,
        (force, previousUrl) => resolveRemoteUrl(
          match.session, match.file, force, previousUrl), {
          onClose: () => {
            finish();
            match.session.activeControllers.delete(controller);
          },
        });
      if (!response.body) {
        finish();
        match.session.activeControllers.delete(controller);
      }
      return response;
    } catch (error) {
      finish();
      match.session.activeControllers.delete(controller);
      return Response.json({
        code: error.code || "REMOTE_STREAM_UNAVAILABLE",
        error: error.message || "The remote stream is unavailable.",
      }, { status: error.status || 502 });
    }
  }

  const range = parseByteRange(request.headers.get("range"), match.file.length);
  if (range.error) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${match.file.length}` },
    });
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(range.end - range.start + 1),
    "Content-Type": match.mimeType,
  });
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${match.file.length}`);
  }
  if (!includeBody) {
    return new Response(null, { status: range.partial ? 206 : 200, headers });
  }

  bufferVideoFile(match.session, match.file, {
    start: range.start,
    end: Math.min(match.file.length - 1, range.end + 16 * 1024 * 1024),
  });
  const finish = beginStream(match.session);
  const source = match.file.stream({ start: range.start, end: range.end });
  const reader = source.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });

  request.signal.addEventListener(
    "abort",
    () => {
      void reader.cancel("Client disconnected");
      finish();
    },
    { once: true },
  );

  return new Response(body, { status: range.partial ? 206 : 200, headers });
}

export async function GET(request, context) {
  return withRemoteMediaCors(await respond(request, context, true));
}

export async function HEAD(request, context) {
  return withRemoteMediaCors(await respond(request, context, false));
}

export function OPTIONS() {
  return remoteMediaOptionsResponse();
}
