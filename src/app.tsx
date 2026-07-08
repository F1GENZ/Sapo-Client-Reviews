import { ConfigProvider, Layout, Tag, Typography, theme } from 'antd';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { appEnv } from './config/env';
import { queryClient } from './lib/query-client';
import { AuthGate } from './components/auth/auth-gate';
import { AdminLayout } from './components/layout/AdminLayout';
import { DashboardContent } from './routes/dashboard-page';
import { GrandservicePage } from './routes/grandservice-page';
import { InstallLoginPage } from './routes/install-login-page';
import { ReviewsPage } from './routes/reviews-page';
import { QnaPage } from './routes/qna-page';
import { SettingsPage } from './routes/settings-page';
import { OpsPage } from './routes/ops-page';

const { Header } = Layout;

const PublicLayout = () => (
  <Layout className="app-shell">
    <Header className="app-header">
      <div className="app-brand">
        <strong>{appEnv.appName}</strong>
        <span>F1GENZ Reviews &amp; Q&amp;A</span>
      </div>
      <Tag color="blue">Sapo</Tag>
    </Header>
    <div className="app-main">
      <Outlet />
    </div>
  </Layout>
);

const ProtectedLayout = () => (
  <AuthGate>
    {() => (
      <AdminLayout>
        <Outlet />
      </AdminLayout>
    )}
  </AuthGate>
);

export const App = () => (
  <ConfigProvider
    theme={{
      algorithm: theme.defaultAlgorithm,
      token: {
        colorPrimary: '#1677ff',
        borderRadius: 12,
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      },
      components: {
        Button: { controlHeight: 44 },
        Input: { controlHeight: 44 },
      },
    }}
  >
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route path="/install/login" element={<InstallLoginPage />} />
            <Route path="/install/grandservice" element={<GrandservicePage />} />
          </Route>
          <Route element={<ProtectedLayout />}>
            <Route path="/dashboard" element={<DashboardContent />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/qna" element={<QnaPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/ops" element={<OpsPage />} />
          </Route>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="*"
            element={
              <Navigate
                to={`/install/login?redirect=${encodeURIComponent('/dashboard')}`}
                replace
              />
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </ConfigProvider>
);
