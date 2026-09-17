import { getSeasonDetails } from "../../../../../../../lib/metadata/tmdb.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, context) {
  try {
    const { id, season } = await context.params;
    const result = await getSeasonDetails(id, season);
    return Response.json(result, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "Could not load that season." },
      { status: Number.isInteger(error.status) ? error.status : 502 },
    );
  }
}
