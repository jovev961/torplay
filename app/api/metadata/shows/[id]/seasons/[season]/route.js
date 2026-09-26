import { getSeasonDetails } from "../../../../../../../lib/metadata/tmdb.js";
import { localeFromRequest } from "../../../../../../../lib/i18n/locales.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, context) {
  try {
    const { id, season } = await context.params;
    const result = await getSeasonDetails(id, season, { locale: localeFromRequest(request) });
    return Response.json(result, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "Could not load that season." },
      { status: Number.isInteger(error.status) ? error.status : 502 },
    );
  }
}
