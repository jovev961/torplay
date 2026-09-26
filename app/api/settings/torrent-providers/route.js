import { assertSettingsMutationRequest, assertSameOriginSettingsRequest } from "../../../../lib/settings/security.js";
import {
  changeCustomProvider,
  changeJackettProvider,
  availableJackettIndexers,
  jackettIndexerCapabilities,
  createCardigannProvider,
  customProviderHealth,
  removeCardigannProvider,
  testCardigannProviderConnection,
  testCustomProvider,
  updateCardigannProvider,
} from "../../../../lib/settings/torrent-providers.js";
import { importDefinition } from "../../../../lib/search/cardigann/definition.js";
import { communityDirectory } from "../../../../lib/search/community-directory.js";
import { changeNativeSource, nativeSourceHealth } from "../../../../lib/settings/native-sources.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  try {
    assertSameOriginSettingsRequest(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }
    if (body?.action === "health") {
      if (request.headers.get("accept")?.includes("application/x-ndjson")) {
        return streamHealth(request, body.refresh === true);
      }
      const [native, custom] = await Promise.all([
        nativeSourceHealth({ refresh: body.refresh === true }),
        customProviderHealth({ refresh: body.refresh === true }),
      ]);
      return json({ results: [...native, ...custom] });
    }
    assertSettingsMutationRequest(request);
    if (["add-native", "update-native", "remove-native"].includes(body?.action)) {
      const action = body.action.replace("-native", "");
      return json({ nativeSources: await changeNativeSource(action, body.provider || {}) });
    }
    if (body?.action === "list-community-definitions") return json(await communityDirectory.list({ refresh: body.refresh === true }));
    if (body?.action === "import-community-definition") return json(await communityDirectory.importEntry(body.provider));
    if (body?.action === "import-definition") return json(await importDefinition(body.definitionUrl));
    if (body?.action === "create-cardigann") return json({ providers: await createCardigannProvider(body.provider || {}) });
    if (body?.action === "update-cardigann") return json({ providers: await updateCardigannProvider(body.provider || {}) });
    if (body?.action === "test-cardigann") return json(await testCardigannProviderConnection(body.provider || {}));
    if (body?.action === "remove-cardigann") return json({ providers: await removeCardigannProvider(body.provider || {}) });
    if (body?.action === "test") return json({ capabilities: await testCustomProvider(body.provider || {}) });
    if (body?.action === "jackett-indexers") return json({ indexers: await availableJackettIndexers() });
    if (body?.action === "jackett-capabilities") return json({ capabilities: await jackettIndexerCapabilities(body.provider?.indexerId) });
    if (["create-jackett", "update-jackett"].includes(body?.action)) return json({ providers: await changeJackettProvider(body.action.replace("-jackett", ""), body.provider || {}) });
    if (!["create", "update", "remove"].includes(body?.action)) return json({ error: "Unknown provider action." }, 400);
    return json({ providers: await changeCustomProvider(body.action, body.provider || {}) });
  } catch (error) {
    return json({
      error: error.status ? error.message : "Provider settings could not be processed.",
      ...(error.code ? { code: error.code } : {}),
      ...(error.unsupportedFeatures ? { unsupportedFeatures: error.unsupportedFeatures } : {}),
      ...(error.verificationFailure ? { verificationFailure: error.verificationFailure } : {}),
      ...(error.canAddUnverified ? { canAddUnverified: true, confirmationToken: error.confirmationToken } : {}),
    }, error.status || 400);
  }
}

function streamHealth(request, refresh) {
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const emit = (event) => {
        if (!closed && !cancellation.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const abort = () => cancellation.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      const options = {
        refresh, signal: cancellation.signal,
        onCached: (result, stale) => emit({ type: "status", result, stale }),
        onResult: (result) => emit({ type: "status", result, stale: false }),
      };
      emit({ type: "started" });
      void Promise.allSettled([nativeSourceHealth(options), customProviderHealth(options)])
        .then((settled) => {
          if (settled.some((result) => result.status === "rejected")) {
            emit({ type: "error", error: "Some source statuses could not be checked." });
          }
          emit({ type: "complete" });
        }).finally(() => {
          request.signal.removeEventListener("abort", abort);
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* The reader may have cancelled the stream. */ }
          }
        });
    },
    cancel() { cancellation.abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  } });
}
