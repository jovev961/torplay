export async function readNdjson(response, onEvent) {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.error || `Request failed (${response.status}).`), {
      code: body?.code || null,
    });
  }
  if (!response.body) throw new Error("Streaming response was empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 5_000_000) throw new Error("Streaming response is too large.");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) onEvent(JSON.parse(line));
        newline = pending.indexOf("\n");
      }
      if (done) { finished = true; break; }
    }
    if (pending.trim()) onEvent(JSON.parse(pending));
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
