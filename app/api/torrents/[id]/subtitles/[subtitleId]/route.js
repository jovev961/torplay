import {
  beginStream,
  getSubtitleFile,
} from "../../../../../../lib/torrent/manager.js";
import {
  MAX_SUBTITLE_BYTES,
  SubtitleError,
  subtitleToWebVtt,
} from "../../../../../../lib/video/subtitles.js";
import {
  remoteMediaOptionsResponse,
  withRemoteMediaCors,
} from "../../../../../../lib/remote-playback/cors.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function respond(request, context) {
  const { id, subtitleId } = await context.params;
  const match = getSubtitleFile(id, subtitleId);
  if (!match) {
    return Response.json({ error: "Subtitle file not found." }, { status: 404 });
  }
  if (match.file.length > MAX_SUBTITLE_BYTES) {
    return Response.json({ error: "The subtitle file is too large." }, { status: 413 });
  }

  const finish = beginStream(match.session);
  const source = match.file.stream();
  const reader = source.getReader();
  const chunks = [];
  let length = 0;
  let aborted = false;
  const abort = () => {
    aborted = true;
    void reader.cancel("Client disconnected");
  };
  request.signal.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SUBTITLE_BYTES) {
        await reader.cancel("Subtitle size limit exceeded");
        throw new SubtitleError("The subtitle file is too large.", 413);
      }
      chunks.push(value);
    }
    if (aborted) return new Response(null, { status: 499 });

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = subtitleToWebVtt(bytes, match.format);
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": match.mimeType,
      },
    });
  } catch (error) {
    const status = error instanceof SubtitleError ? error.status : 502;
    const message = error instanceof SubtitleError
      ? error.message
      : "The subtitle file could not be downloaded.";
    return Response.json({ error: message }, { status });
  } finally {
    request.signal.removeEventListener("abort", abort);
    finish();
  }
}

export async function GET(request, context) {
  return withRemoteMediaCors(await respond(request, context));
}

export async function HEAD(request, context) {
  return withRemoteMediaCors(await respond(request, context), { includeBody: false });
}

export function OPTIONS() {
  return remoteMediaOptionsResponse();
}
