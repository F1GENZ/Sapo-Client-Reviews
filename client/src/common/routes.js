const INTERNAL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

function appendStoreDomainToPath(path, storeDomain) {
  const currentPath =
    typeof window !== "undefined" ? window.location.pathname : "/";
  const basePath =
    path.startsWith("?") || path.startsWith("#")
      ? `${currentPath}${path}`
      : path || "/";

  const url = new URL(basePath, window.location.origin);
  if (!url.searchParams.get("storeDomain")) {
    url.searchParams.set("storeDomain", storeDomain);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function withStoreDomain(to, storeDomain) {
  if (!storeDomain || typeof window === "undefined") {
    return to;
  }

  if (typeof to === "string") {
    if (INTERNAL_PROTOCOL_RE.test(to) || to.startsWith("//")) {
      return to;
    }
    return appendStoreDomainToPath(to, storeDomain);
  }

  if (!to || typeof to !== "object") return to;

  const path = `${to.pathname || window.location.pathname}${to.search || ""}${to.hash || ""}`;
  const routed = appendStoreDomainToPath(path, storeDomain);
  const url = new URL(routed, window.location.origin);
  return {
    ...to,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
}

export function buildLoginPath({ storeDomain, error } = {}) {
  const params = new URLSearchParams();
  if (storeDomain) params.set("storeDomain", storeDomain);
  if (error) params.set("error", error);
  const query = params.toString();
  return query ? `/install/login?${query}` : "/install/login";
}
