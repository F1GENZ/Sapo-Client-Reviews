import { forwardRef } from "react";
import { Link } from "react-router-dom";
import { useStoreRoute } from "../hooks/useStoreRoute";

const StoreLink = forwardRef(({ to, ...props }, ref) => {
  const route = useStoreRoute();

  return <Link ref={ref} to={route(to)} {...props} />;
});

StoreLink.displayName = "StoreLink";

export default StoreLink;
