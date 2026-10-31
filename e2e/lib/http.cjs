const crypto = require("crypto");

async function call(baseUrl, route, { method = "GET", headers = {}, json, body, redirect = "manual" } = {}) {
  const init = { method, headers: { ...headers }, redirect };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["content-type"] = init.headers["content-type"] || "application/json";
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(`${baseUrl}${route}`, init);
  const raw = await res.text();
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep text */
  }
  const headerMap = {};
  for (const [key, value] of res.headers.entries()) headerMap[key.toLowerCase()] = value;
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    headers: headerMap,
    setCookie,
    raw,
    body: parsed,
    request: { method, route, headers: Object.keys(headers) },
  };
}

function findDeep(value, predicate, out = []) {
  if (Array.isArray(value)) value.forEach((item) => findDeep(item, predicate, out));
  else if (value && typeof value === "object") {
    if (predicate(value)) out.push(value);
    Object.values(value).forEach((item) => findDeep(item, predicate, out));
  }
  return out;
}

function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

function signLaunch(params, secret, encoding = "base64") {
  const message = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest(encoding);
}

function launchQueryString(params, secret, encoding = "base64") {
  return new URLSearchParams({ ...params, hmac: signLaunch(params, secret, encoding) }).toString();
}

function hmacOf(data, secret, encoding) {
  return crypto.createHmac("sha256", secret).update(data).digest(encoding);
}

function mintSession(payload, secret) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function uploadForm(bytes, { type = "image/png", name = "photo" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return form;
}

module.exports = { call, findDeep, collectKeys, signLaunch, launchQueryString, hmacOf, mintSession, TINY_PNG, uploadForm };
