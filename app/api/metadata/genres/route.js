import { getGenreDefinitions } from "../../../../lib/metadata/tmdb.js";
import { localeFromRequest } from "../../../../lib/i18n/locales.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const genres = await getGenreDefinitions(params.get("type") || "all", { locale: localeFromRequest(request) });
    return Response.json({ genres }, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (error) {
    return Response.json(
      { error: error.message || "Could not load genres." },
      { status: Number.isInteger(error.status) ? error.status : 502 },
    );
  }
}
