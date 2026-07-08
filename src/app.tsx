import { ConfigProvider, Layout, Tag, Typography, theme } from 'antd';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { appEnv } from './config/env';
import { queryClient } from './lib/query-client';
import { DashboardPage } from './routes/dashboard-page';
import { GrandservicePage } from './routes/grandservice-page';
import { InstallLoginPage } from './routes/install-login-page';

const { Content, Header } = Layout;
const { Text } = Typography;

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
        <Layout className="app-shell">
          <Header className="app-header">
            <div className="app-brand">
              <strong>{appEnv.appName}</strong>
              <span>Secure Sapo lifecycle starter</span>
            </div>
            <Tag color="blue">Lifecycle MVP</Tag>
          </Header>
          <Content className="app-main">
            <Routes>
              <Route path="/install/login" element={<InstallLoginPage />} />
              <Route path="/install/grandservice" element={<GrandservicePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
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
            <Text type="secondary">
              V1 never stores Sapo access tokens or app bearer sessions in browser storage.
            </Text>
          </Content>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  </ConfigProvider>
);
