// Rewrites outbound https://*.mysapo.net requests onto the local Sapo stub so the suite never calls a real store.
const stubPort = Number(process.env.E2E_SAPO_STUB_PORT || 0);
if (!stubPort) throw new Error("E2E_SAPO_STUB_PORT is required by sapo-fetch-redirect.cjs");

const nativeFetch = globalThis.fetch;
globalThis.fetch = function e2eFetch(input, init) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (/\.mysapo\.net$/i.test(url.hostname)) {
    const headers = new Headers((init && init.headers) || (typeof input === "object" && input.headers) || {});
    headers.set("x-e2e-sapo-host", url.hostname.toLowerCase());
    const target = `http://127.0.0.1:${stubPort}${url.pathname}${url.search}`;
    return nativeFetch(target, { ...(init || {}), headers });
  }
  return nativeFetch(input, init);
};
