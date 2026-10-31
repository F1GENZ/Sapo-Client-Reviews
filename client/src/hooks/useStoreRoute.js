import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getStoreDomain } from "../common/AuthStorage";
import { withStoreDomain } from "../common/routes";

export function useStoreRoute() {
  const location = useLocation();
  const storeDomain = getStoreDomain();

  return useCallback(
    (to) => withStoreDomain(to, storeDomain),
    [location.search, storeDomain],
  );
}

export function useStoreNavigate() {
  const navigate = useNavigate();
  const route = useStoreRoute();

  return useCallback(
    (to, options) => navigate(route(to), options),
    [navigate, route],
  );
}
