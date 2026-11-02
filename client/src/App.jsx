import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState, Component, lazy, Suspense } from "react";
import { reportClientError } from "./common/ErrorReporter";
import {
  getActiveStoreDomain,
  getStoreDomain,
  isAuthVerified,
  syncAuthSession,
} from "./common/AuthStorage";
import { resolveAuthBootstrap } from "./common/authBootstrap";
import AuthScreen from "./pages/auth/AuthScreen";

const Login = lazy(() => import("./pages/auth/login/index"));
const DashboardPage = lazy(() => import("./pages/dashboard/index"));
const ReviewsPage = lazy(() => import("./pages/reviews/index"));
const QnaPage = lazy(() => import("./pages/qna/index"));
const SettingsPage = lazy(() => import("./pages/settings/index"));
const GuidePage = lazy(() => import("./pages/guide/index"));
const DevGuidePage = lazy(() => import("./pages/dev/index"));
const ContactPage = lazy(() => import("./pages/contact/index"));
const OpsPage = lazy(() => import("./pages/ops/index"));
const WebhooksPage = lazy(() => import("./pages/webhooks/index"));

const PageLoader = () => (
  <div className="f1g-route-loader" role="status" aria-live="polite" aria-label="Đang tải">
    <div className="f1g-route-spinner" aria-hidden="true" />
  </div>
);

const isPublicPath = (pathname) =>
  pathname.startsWith("/install") || pathname.startsWith("/oauth");

function StoreDomainUrlKeeper() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (isPublicPath(location.pathname)) return;
    syncAuthSession();
    const storeDomain = getStoreDomain() || getActiveStoreDomain();
    if (!storeDomain || !isAuthVerified(storeDomain)) return;

    const params = new URLSearchParams(location.search);
    if (params.get("storeDomain") === storeDomain) return;

    params.set("storeDomain", storeDomain);
    navigate(`${location.pathname}?${params.toString()}${location.hash}`, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);

  return null;
}

class ErrorBoundary extends Component {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    reportClientError("ErrorBoundary", error, { componentStack: info?.componentStack });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="f1g-error-shell">
          <div className="f1g-error-panel" role="alert">
            <h1>Đã xảy ra lỗi</h1>
            <p>Trang gặp sự cố. Vui lòng tải lại.</p>
            <button type="button" onClick={() => window.location.reload()}>
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const isAuthPage = isPublicPath(window.location.pathname);
  const [ready, setReady] = useState(isAuthPage);

  useEffect(() => {
    if (isAuthPage) return undefined;
    let cancelled = false;
    resolveAuthBootstrap().then((result) => {
      if (cancelled) return;
      if (result.ready) setReady(true);
      else window.location.replace(result.redirectTo);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthPage]);

  if (!ready) return <AuthScreen />;

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <StoreDomainUrlKeeper />
        <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/qna" element={<QnaPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="/dev" element={<DevGuidePage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/integrations" element={<WebhooksPage />} />
          <Route path="/health" element={<OpsPage />} />
          <Route path="/ops" element={<OpsPage />} />
          <Route path="/install/login" element={<Login />} />
          <Route path="*" element={<Navigate to={`/${window.location.search}`} replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
