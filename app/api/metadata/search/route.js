import { searchCatalog } from "../../../../lib/metadata/tmdb.js";
import { localeFromRequest } from "../../../../lib/i18n/locales.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const result = await searchCatalog({
      query: params.get("q"),
      type: params.get("type") || "all",
      genre: params.get("genre") || "",
      page: params.get("page") || 1,
      locale: localeFromRequest(request),
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "Metadata search failed." },
      { status: Number.isInteger(error.status) ? error.status : 502 },
    );
  }
}
