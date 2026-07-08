import { Button, Layout, Menu, Typography } from 'antd';
import {
  DashboardOutlined,
  CommentOutlined,
  MessageOutlined,
  SettingOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { getSessionProbe, logout } from '../../api/auth-api';
import { clearStoredDomain } from '../../lib/store-context';
import { reportError } from '../../lib/error-reporter';
import './AdminLayout.css';

const { Sider, Content, Header } = Layout;
const { Text } = Typography;

const NAV_ITEMS = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/reviews', icon: <CommentOutlined />, label: 'Reviews' },
  { key: '/qna', icon: <MessageOutlined />, label: 'Q&A' },
  { key: '/settings', icon: <SettingOutlined />, label: 'Settings' },
  { key: '/ops', icon: <ToolOutlined />, label: 'Ops' },
];

export type AdminLayoutProps = {
  children: React.ReactNode;
};

export const AdminLayout = ({ children }: AdminLayoutProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: session } = useQuery({
    queryKey: ['session-probe'],
    queryFn: getSessionProbe,
    staleTime: 5 * 60 * 1000,
  });

  const selectedKey = NAV_ITEMS.find(
    (item) => location.pathname.startsWith(item.key),
  )?.key ?? '/dashboard';

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
    <Layout className="admin-layout">
      <Sider className="admin-sider" width={240}>
        <div className="admin-sider-brand">
          <Text strong>F1GENZ Reviews</Text>
        </div>
        <Menu
          className="admin-sider-menu"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={NAV_ITEMS.map(({ icon, ...rest }) => ({ ...rest }))}
          onClick={({ key }) => navigate(key)}
        />
        <div className="admin-sider-footer">
          <Button danger block onClick={() => void handleLogout()}>
            Logout
          </Button>
        </div>
      </Sider>
      <Layout>
        <Header className="admin-header">
          <Text type="secondary">
            {session?.storeDomain ?? 'Loading…'}
          </Text>
        </Header>
        <Content className="admin-content">
          {children}
        </Content>
      </Layout>
    </Layout>
  );
};
