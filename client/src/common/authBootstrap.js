import {
  getActiveStoreDomain,
  getStoreDomain,
  isAuthVerified,
  setPostAuthRedirect,
  syncAuthSession,
} from "./AuthStorage";
import { completeHandoff, getAuthenticatedRedirect } from "./authFlow";
import { buildLoginPath } from "./routes";

let pending = null;

export function resolveAuthBootstrap() {
  if (!pending) pending = run();
  return pending;
}

async function run() {
  syncAuthSession();
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);

  if (params.has("hmac")) return { redirectTo: `/install/login${search}` };

  const handoffCode = params.get("handoff_code");
  if (handoffCode) {
    try {
      const { storeDomain, redirectTo } = await completeHandoff(handoffCode);
      window.history.replaceState({}, "", getAuthenticatedRedirect(storeDomain, redirectTo));
      syncAuthSession();
      return { ready: true };
    } catch {
      return { redirectTo: buildLoginPath({ storeDomain: getStoreDomain(), error: "handoff_failed" }) };
    }
  }

  const urlStoreDomain = getStoreDomain();
  if (urlStoreDomain) {
    if (isAuthVerified(urlStoreDomain)) return { ready: true };
    setPostAuthRedirect(pathname + search + hash);
    return { redirectTo: buildLoginPath({ storeDomain: urlStoreDomain }) };
  }

  const activeStoreDomain = getActiveStoreDomain();
  if (activeStoreDomain && isAuthVerified(activeStoreDomain)) {
    const next = new URL(window.location.href);
    next.searchParams.set("storeDomain", activeStoreDomain);
    window.history.replaceState({}, "", next.pathname + next.search + next.hash);
    syncAuthSession();
    return { ready: true };
  }

  setPostAuthRedirect(pathname + search + hash);
  return { redirectTo: buildLoginPath({ storeDomain: activeStoreDomain }) };
}
