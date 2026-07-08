import { Badge, Button, Card, Descriptions, Result, Space, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { logout, type SessionProbeResponse } from '../api/auth-api';
import { AuthGate } from '../components/auth/auth-gate';
import { clearStoredDomain } from '../lib/store-context';
import { reportError } from '../lib/error-reporter';

const { Paragraph, Text, Title } = Typography;

const statusColor = (status: string): 'success' | 'warning' | 'error' | 'default' => {
  if (status === 'active' || status === 'trial' || status === 'free') return 'success';
  if (status === 'canceled' || status === 'expired' || status === 'needs_reinstall' || status === 'declined') return 'warning';
  if (status === 'uninstalled') return 'error';
  return 'default';
};

const webhookColor = (status: string): 'success' | 'processing' | 'warning' | 'error' | 'default' => {
  if (status === 'registered') return 'success';
  if (status === 'pending') return 'processing';
  if (status === 'degraded') return 'warning';
  if (status === 'failed') return 'error';
  return 'default';
};

const DashboardContent = ({ session }: { session: SessionProbeResponse }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
    } catch (error) {
      reportError('logout', error);
    } finally {
      clearStoredDomain();
      queryClient.clear();
      navigate('/install/login', { replace: true });
    }
  };

  return (
    <Space direction="vertical" size="large" className="full-width-space">
      <Card>
        <Space direction="vertical" size="middle" className="full-width-space">
          <div>
            <Title level={2}>Protected dashboard</Title>
            <Paragraph>
              This page is intentionally minimal. It proves the server-side app session, store domain match, and guarded token resolution without trusting local browser flags.
            </Paragraph>
          </div>
          <Descriptions bordered column={{ xs: 1, sm: 1, md: 2 }}>
            <Descriptions.Item label="Store Domain">
              <Text copyable>{session.storeDomain}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Shop domain">
              {session.shopDomain || 'Not resolved'}
            </Descriptions.Item>
            <Descriptions.Item label="Install status">
              <Badge status={statusColor(session.status)} text={session.status} />
            </Descriptions.Item>
            <Descriptions.Item label="Plan">
              {session.plan}
            </Descriptions.Item>
            <Descriptions.Item label="Webhook status" span={2}>
              <Badge status={webhookColor(session.webhookStatus)} text={session.webhookStatus} />
            </Descriptions.Item>
          </Descriptions>
          <Space wrap>
            <Button onClick={() => void queryClient.invalidateQueries({ queryKey: ['session-probe'] })}>
              Refresh session probe
            </Button>
            <Button danger onClick={() => void handleLogout()}>
              Clear app session
            </Button>
          </Space>
        </Space>
      </Card>
      <Result
        status="info"
        title="Lifecycle MVP only"
        subTitle="Add app-specific menus after the OAuth, session, webhook, subscription, and uninstall lifecycle is verified for a real app."
      />
    </Space>
  );
};

export const DashboardPage = () => (
  <AuthGate>
    {(session) => <DashboardContent session={session} />}
  </AuthGate>
);
