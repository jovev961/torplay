import { getImdbRatings } from "../../../../lib/metadata/imdb-ratings.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const ratings = await getImdbRatings(body?.items);
    return Response.json({ ratings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "IMDb ratings could not be loaded." },
      { status: Number.isInteger(error.status) ? error.status : 502 },
    );
  }
}
