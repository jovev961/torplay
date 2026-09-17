import {
  beginStream,
  bufferVideoFile,
  getVideoFile,
} from "../../../../../../../lib/torrent/manager.js";
import { parseByteRange } from "../../../../../../../lib/video/range.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function respond(request, context, includeBody) {
  const { id, fileId } = await context.params;
  const match = getVideoFile(id, fileId);
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

export function GET(request, context) {
  return respond(request, context, true);
}

export function HEAD(request, context) {
  return respond(request, context, false);
}
