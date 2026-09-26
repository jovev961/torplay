import { discoverCatalog } from "../../../../lib/metadata/tmdb.js";
import { localeFromRequest } from "../../../../lib/i18n/locales.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const result = await discoverCatalog({
      type: params.get("type") || "all",
      genre: params.get("genre") || "",
      page: params.get("page") || 1,
      locale: localeFromRequest(request),
    });
    return Response.json(result, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
    });
  } catch (error) {
    return Response.json(
      { error: error.message || "Metadata discovery failed." },
      { status: Number.isInteger(error.status) ? error.status : 502 },
    );
  }
}
