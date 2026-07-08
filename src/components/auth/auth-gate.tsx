import { Alert, Button, Card, Result, Skeleton, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { getSessionProbe, type SessionProbeResponse } from '../../api/auth-api';
import { getErrorMessage } from '../../lib/get-error-message';
import { getSafeCurrentPath } from '../../lib/auth-flow';

export type AuthGateProps = {
  children: (session: SessionProbeResponse) => React.ReactNode;
};

export const AuthGate = ({ children }: AuthGateProps) => {
  const navigate = useNavigate();
  const sessionQuery = useQuery({
    queryKey: ['session-probe'],
    queryFn: getSessionProbe,
    retry: false,
  });

  if (sessionQuery.isLoading) {
    return (
      <Card className="center-card" aria-live="polite">
        <Skeleton active paragraph={{ rows: 4 }} title />
      </Card>
    );
  }

  if (sessionQuery.isError) {
    const message = getErrorMessage(sessionQuery.error);
    const expired = /401|missing auth session|invalid auth session|expired auth session|app needs reinstall/i.test(message);
    return (
      <Result
        className="center-card"
        status={expired ? '403' : 'warning'}
        title={expired ? 'Secure session required' : 'Could not load app session'}
        subTitle={
          <Space direction="vertical" size="middle" className="full-width-space">
            <span>
              {expired
                ? 'Open the app through Sapo Admin or start a secure login to create a new HttpOnly session.'
                : 'The server session probe failed. No local browser flag is trusted as authentication.'}
            </span>
            <Alert type="info" showIcon message={message} />
          </Space>
        }
        extra={[
          <Button
            type="primary"
            key="login"
            onClick={() => navigate(`/install/login?redirect=${encodeURIComponent(getSafeCurrentPath())}`)}
          >
            Start secure login
          </Button>,
          <Button key="retry" onClick={() => void sessionQuery.refetch()}>
            Retry session check
          </Button>,
        ]}
      />
    );
  }

  if (!sessionQuery.data) {
    return (
      <Result
        className="center-card"
        status="warning"
        title="Session probe returned no data"
        subTitle="The protected dashboard only opens after the backend confirms the HttpOnly app session."
        extra={[
          <Button key="retry" type="primary" onClick={() => void sessionQuery.refetch()}>
            Retry session check
          </Button>,
        ]}
      />
    );
  }

  return <>{children(sessionQuery.data)}</>;
};
