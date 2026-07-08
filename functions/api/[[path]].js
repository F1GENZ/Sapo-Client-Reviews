const appendForwarded = (headers, requestUrl, request) => {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for');
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(':', ''));
  if (ip) headers.set('x-forwarded-for', ip);
};

export async function onRequest(context) {
  const backendUrl = context.env.BACKEND_URL;
  if (!backendUrl || !/^https?:\/\//i.test(backendUrl)) {
    return Response.json(
      { error: 'BACKEND_URL must be configured for the Cloudflare Pages API proxy' },
      { status: 500 },
    );
  }

  const incomingUrl = new URL(context.request.url);
  const upstreamUrl = new URL(incomingUrl.pathname + incomingUrl.search, backendUrl.replace(/\/$/, ''));
  const headers = new Headers(context.request.headers);
  appendForwarded(headers, incomingUrl, context.request);
  headers.delete('host');

  const init = {
    method: context.request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(context.request.method.toUpperCase())) {
    init.body = context.request.body;
  }

  return fetch(upstreamUrl.toString(), init);
}
