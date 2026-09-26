import { getPlaybackVideoFile } from "../../../../../../../lib/debrid/session.js";
import {
  readVideoFilePrefetch,
  startVideoFilePrefetch,
  stopVideoFilePrefetch,
} from "../../../../../../../lib/playback/prefetch.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function localMatch(context) {
  const { id, fileId } = await context.params;
  const match = getPlaybackVideoFile(id, fileId);
  if (!match) return { error: Response.json({ error: "Playable video file not found." }, { status: 404 }) };
  if (match.backend === "debrid") {
    return { error: Response.json({
      code: "PREFETCH_UNSUPPORTED",
      error: "Debrid playback is already prepared by the connected provider.",
    }, { status: 409 }) };
  }
  return { match };
}

export async function POST(_request, context) {
  const result = await localMatch(context);
  if (result.error) return result.error;
  return Response.json(startVideoFilePrefetch(result.match.session, result.match.file), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(_request, context) {
  const result = await localMatch(context);
  if (result.error) return result.error;
  return Response.json(readVideoFilePrefetch(result.match.session, result.match.file), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(_request, context) {
  const result = await localMatch(context);
  if (result.error) return result.error;
  return Response.json(stopVideoFilePrefetch(result.match.session, result.match.file), {
    headers: { "Cache-Control": "no-store" },
  });
}
