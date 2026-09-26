import { watchTogetherConfiguration } from "../../../../lib/watch-together/config.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json(watchTogetherConfiguration(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { enabled: false, signalUrl: null, stunUrls: [], error: error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
