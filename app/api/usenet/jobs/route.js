import { createUsenetJob, listUsenetJobs } from "../../../../lib/usenet/jobs.js";
import { getSearchResult } from "../../../../lib/search/result-store.js";
import { validateNzb } from "../../../../lib/usenet/newznab.js";
import { assertSameOriginSettingsRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json({ jobs: await listUsenetJobs() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error.message }, { status: error.status || 502 }); }
}

export async function POST(request) {
  try {
    assertSameOriginSettingsRequest(request);
    let input;
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size > 2_000_000 || !/\.nzb$/i.test(file.name)) {
        return Response.json({ error: "Choose an NZB file up to 2 MB." }, { status: 400 });
      }
      const context = form.get("mediaContext");
      input = { buffer: validateNzb(Buffer.from(await file.arrayBuffer())), title: file.name,
        mediaContext: context ? JSON.parse(context) : null };
    } else {
      const body = await request.json();
      const source = getSearchResult(body?.resultId);
      if (source?.kind !== "nzb") return Response.json({ error: "NZB result expired. Search again." }, { status: 404 });
      input = source;
    }
    return Response.json(await createUsenetJob(input), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 422 });
  }
}
