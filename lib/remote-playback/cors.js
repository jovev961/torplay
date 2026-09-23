export function remoteMediaHeaders(input = {}) {
  const headers = new Headers(input);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept-Encoding, Range");
  headers.set("Access-Control-Allow-Private-Network", "true");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
  return headers;
}

export function withRemoteMediaCors(response, { includeBody = true } = {}) {
  return new Response(includeBody ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: remoteMediaHeaders(response.headers),
  });
}

export function remoteMediaOptionsResponse() {
  return new Response(null, { status: 204, headers: remoteMediaHeaders() });
}
