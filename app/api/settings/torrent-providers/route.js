import { assertSameOriginSettingsRequest, assertSettingsMutationRequest } from "../../../../lib/settings/security.js";
import { configure, sourceHealth } from "../../../../lib/sources/configuration.js";
import { importDefinition } from "../../../../lib/sources/cardigann/definition.js";
import { communityDirectory } from "../../../../lib/sources/community.js";
import { SourceError } from "../../../../lib/sources/contract.js";
import { NetworkError } from "../../../../lib/network/request.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  try {
    assertSameOriginSettingsRequest(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }
    if (body?.action === "health") {
      if (request.headers.get("accept")?.includes("application/x-ndjson")) return streamHealth(request, body.refresh === true);
      return json({ results: await sourceHealth({ refresh: body.refresh === true, signal: request.signal }) });
    }
    assertSettingsMutationRequest(request);
    const options = { signal: request.signal };
    if (body?.action === "list-community-definitions") return json(await communityDirectory.list({ ...options, refresh: body.refresh === true }));
    if (body?.action === "import-community-definition") return json(await communityDirectory.importEntry(body.provider, options));
    if (body?.action === "import-definition") return json(await importDefinition(body.definitionUrl, options));
    return json(await configure(body?.action, body?.provider || {}, options));
  } catch (error) {
    return json({ error: error instanceof SourceError || error instanceof NetworkError || error.status === 403
      ? error.message : "Source settings could not be processed.",
      ...(error instanceof SourceError || error instanceof NetworkError ? { code: error.code } : {}),
      ...(error.unsupportedFeatures ? { unsupportedFeatures: error.unsupportedFeatures } : {}),
    }, error.status || 400);
  }
}

function streamHealth(request, refresh) {
  const cancellation = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event) => {
        if (!closed && !cancellation.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const abort = () => cancellation.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      emit({ type: "started" });
      void sourceHealth({ refresh, signal: cancellation.signal,
        onCached: (result, stale) => emit({ type: "status", result, stale }),
        onResult: (result) => emit({ type: "status", result, stale: false }),
      }).then(() => emit({ type: "complete" })).catch(() => emit({ type: "error", error: "Some source statuses could not be checked." }))
        .finally(() => {
          request.signal.removeEventListener("abort", abort);
          if (!closed) { closed = true; try { controller.close(); } catch { /* Reader cancelled. */ } }
        });
    },
    cancel() { closed = true; cancellation.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
