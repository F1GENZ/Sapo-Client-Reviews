export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const BACKEND_URL = env.BACKEND_URL;
  if (!BACKEND_URL) {
    return new Response(JSON.stringify({ message: 'BACKEND_URL is not configured' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const targetUrl = new URL(url.pathname + url.search, BACKEND_URL);

  const proxyRequest = new Request(targetUrl, request);
  proxyRequest.headers.set('X-Forwarded-Host', url.hostname);

  const response = await fetch(proxyRequest);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
