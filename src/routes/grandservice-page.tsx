import { Alert, Button, Card, Result, Space, Spin, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { exchangeSession, processGrandserviceCallback } from '../api/auth-api';
import {
  beginAuthFlowOnce,
  buildAuthFlowKey,
  safeRedirectOrDashboard,
  stripSensitiveUrlParams,
} from '../lib/auth-flow';
import { getErrorMessage } from '../lib/get-error-message';
import { rememberStoreDomain } from '../lib/store-context';
import { reportError } from '../lib/error-reporter';

const { Paragraph, Text, Title } = Typography;

type InstallState =
  | { kind: 'loading'; title: string; detail: string }
  | { kind: 'error'; title: string; detail: string };

export const GrandservicePage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const flowKey = useMemo(
    () => buildAuthFlowKey(location.pathname, location.search, location.hash),
    [location.hash, location.pathname, location.search],
  );
  const [state, setState] = useState<InstallState>({
    kind: 'loading',
    title: 'Completing app install…',
    detail: 'Verifying install callback and storing Sapo tokens on the server only.',
  });

  useEffect(() => {
    if (!beginAuthFlowOnce(flowKey)) return;

    const run = async (): Promise<void> => {
      const params = new URLSearchParams(location.search);
      const code = params.get('code');
      const stateParam = params.get('state');

      if (!code) {
        stripSensitiveUrlParams();
        setState({
          kind: 'error',
          title: 'Install callback is missing a code',
          detail: 'Start install again from Sapo so the backend can verify OAuth state and exchange the code for an access token.',
        });
        return;
      }

      try {
        const handoff = await processGrandserviceCallback(code, stateParam);
        setState({
          kind: 'loading',
          title: 'Creating secure session…',
          detail: 'Consuming the one-time install handoff and setting the HttpOnly session cookie.',
        });
        const session = await exchangeSession(handoff.handoffCode);
        rememberStoreDomain(session.storeDomain || handoff.storeDomain);
        stripSensitiveUrlParams();
        navigate(safeRedirectOrDashboard(session.redirectTo || handoff.redirectTo), { replace: true });
      } catch (error) {
        reportError('grandservice', error);
        stripSensitiveUrlParams();
        setState({
          kind: 'error',
          title: 'Install could not be completed',
          detail: getErrorMessage(error),
        });
      }
    };

    void run();
  }, [flowKey, location.search, navigate]);

  if (state.kind === 'error') {
    return (
      <Result
        className="center-card"
        status="warning"
        title={state.title}
        subTitle={
          <Space direction="vertical" size="middle" className="full-width-space">
            <Paragraph>
              The frontend did not receive a reusable token. Restart the install flow so the server can create a fresh handoff.
            </Paragraph>
            <Alert showIcon type="warning" message={state.detail} />
          </Space>
        }
        extra={[
          <Button key="login" type="primary" onClick={() => navigate('/install/login', { replace: true })}>
            Restart secure install
          </Button>,
        ]}
      />
    );
  }

  return (
    <Card className="center-card" aria-live="polite">
      <Space direction="vertical" size="large" className="full-width-space">
        <Spin size="large" />
        <div>
          <Title level={2}>{state.title}</Title>
          <Paragraph>{state.detail}</Paragraph>
          <Text type="secondary">
            Access and refresh tokens are encrypted by the backend and never stored in this browser shell.
          </Text>
        </div>
      </Space>
    </Card>
  );
};
