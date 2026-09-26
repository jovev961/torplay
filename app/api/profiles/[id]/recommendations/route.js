import { getRecommendations } from "../../../../../lib/metadata/recommendations.js";
import { localeFromRequest } from "../../../../../lib/i18n/locales.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, context) {
  try {
    const { id } = await context.params;
    const mode = new URL(request.url).searchParams.get("mode") || "recent";
    return Response.json(await getRecommendations(id, { mode, locale: localeFromRequest(request) }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error.message || "Recommendations are unavailable." }, {
      status: Number.isInteger(error.status) ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
