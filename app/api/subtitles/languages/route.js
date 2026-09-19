import { getSubtitleLanguageCatalog } from "../../../../lib/subtitles/languages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await getSubtitleLanguageCatalog();
  return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
}
