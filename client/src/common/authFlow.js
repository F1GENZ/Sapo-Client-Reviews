import { exchangeHandoff } from "./ApiService";
import {
  consumePostAuthRedirect,
  getActiveStoreDomain,
  normalizeStoreDomain,
  setAuthSession,
} from "./AuthStorage";
import { resetClientCache } from "./queryClient";

const AUTH_PARAMS = [
  "handoff_code",
  "hmac",
  "store",
  "timestamp",
  "code",
  "state",
  "scope",
  "error",
  "message",
];

const SAPO_STORE_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.mysapo\.net$/;

export function parseStoreDomainInput(value) {
  let text = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "");
  text = text.split(/[/?#]/)[0];
  if (!text) return null;
  if (!text.includes(".")) text = `${text}.mysapo.net`;
  if (!SAPO_STORE_DOMAIN_PATTERN.test(text)) return null;
  return normalizeStoreDomain(text);
}

export function sanitizeInternalRedirect(targetUrl, storeDomain) {
  let next;
  try {
    next = new URL(targetUrl || "/", window.location.origin);
  } catch {
    next = new URL("/", window.location.origin);
  }
  if (next.origin !== window.location.origin) {
    next = new URL("/", window.location.origin);
  }
  if (next.pathname === "/dashboard") next.pathname = "/";
  if (storeDomain) next.searchParams.set("storeDomain", storeDomain);
  AUTH_PARAMS.forEach((key) => next.searchParams.delete(key));
  return next.pathname + next.search + next.hash;
}

export function getAuthenticatedRedirect(storeDomain, serverRedirect) {
  return sanitizeInternalRedirect(
    consumePostAuthRedirect(storeDomain) || serverRedirect || "/",
    storeDomain,
  );
}

export async function activateStoreSession(storeDomain, sessionToken) {
  const previous = getActiveStoreDomain();
  if (previous && previous !== storeDomain) {
    await resetClientCache();
  }
  setAuthSession(storeDomain, sessionToken);
}

export async function completeHandoff(handoffCode) {
  const result = await exchangeHandoff(handoffCode);
  if (!result?.ok || !result?.storeDomain || !result?.sessionToken) {
    throw new Error("Invalid session exchange response");
  }
  await activateStoreSession(result.storeDomain, result.sessionToken);
  return { storeDomain: result.storeDomain, redirectTo: result.redirectTo };
}

export function navigateTopLevel(url) {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url;
      return;
    }
  } catch {
  }
  window.location.href = url;
}
