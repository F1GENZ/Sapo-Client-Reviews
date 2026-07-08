import { Alert, Button, Card, Result, Space, Spin, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  exchangeSession,
  isAuthStartResponse,
  isHandoffResponse,
  processGrandserviceCallback,
  startLogin,
  verifyLaunchHmac,
  type AuthFlowResponse,
} from '../api/auth-api';
import {
  beginAuthFlowOnce,
  buildAuthFlowKey,
  getSafeRedirectParam,
  hasLaunchHmac,
  hasOAuthCode,
  safeRedirectOrDashboard,
  stripSensitiveUrlParams,
} from '../lib/auth-flow';
import { getErrorMessage } from '../lib/get-error-message';
import { readStoreDomainFromSearch, rememberStoreDomain } from '../lib/store-context';
import { reportError } from '../lib/error-reporter';

const { Paragraph, Text, Title } = Typography;

type PageState =
  | { kind: 'loading'; title: string; detail: string }
  | { kind: 'redirecting'; title: string; detail: string }
  | { kind: 'error'; title: string; detail: string; canStartLogin: boolean };

const safeExternalRedirect = (url: string): boolean => /^https?:\/\//i.test(url);

export const InstallLoginPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const flowKey = useMemo(
    () => buildAuthFlowKey(location.pathname, location.search, location.hash),
    [location.hash, location.pathname, location.search],
  );
  const [state, setState] = useState<PageState>({
    kind: 'loading',
    title: 'Checking Sapo launch…',
    detail: 'Validating launch parameters before creating a secure app session.',
  });

  const exchangeAndRedirect = async (response: AuthFlowResponse): Promise<void> => {
    if (isAuthStartResponse(response)) {
      stripSensitiveUrlParams();
      if (!safeExternalRedirect(response.url)) throw new Error('Backend returned an invalid login URL');
      setState({
        kind: 'redirecting',
        title: 'Redirecting to secure Sapo login…',
        detail: response.reason || 'OAuth SSO is required before this app can open.',
      });
      window.location.assign(response.url);
      return;
    }

    if (!isHandoffResponse(response)) throw new Error('Backend did not return a valid auth response');
    setState({
      kind: 'loading',
      title: 'Creating secure session…',
      detail: 'Consuming the one-time handoff code and setting the HttpOnly session cookie.',
    });
    const session = await exchangeSession(response.handoffCode);
    rememberStoreDomain(session.storeDomain || response.storeDomain);
    stripSensitiveUrlParams();
    navigate(safeRedirectOrDashboard(session.redirectTo || response.redirectTo), { replace: true });
  };

  useEffect(() => {
    if (!beginAuthFlowOnce(flowKey)) return;

    const run = async (): Promise<void> => {
      const params = new URLSearchParams(location.search);
      const storeDomain = readStoreDomainFromSearch(location.search);
      const redirectTo = getSafeRedirectParam(location.search);
      const hasCode = hasOAuthCode(location.search);
      const hasHmac = hasLaunchHmac(location.search);

      try {
        if (hasCode && hasHmac) {
          throw new Error('Ambiguous callback: OAuth code and signed launch HMAC cannot be processed together. Reopen the app from Sapo Admin.');
        }

        if (hasCode) {
          setState({
            kind: 'loading',
            title: 'Completing secure login…',
            detail: 'Verifying OAuth state and exchanging the callback code on the server.',
          });
          const response = await processGrandserviceCallback(params.get('code') || '', params.get('state'));
          await exchangeAndRedirect(response);
          return;
        }

        if (hasHmac) {
          setState({
            kind: 'loading',
            title: 'Checking Sapo launch…',
            detail: 'Verifying signed Sapo Admin launch parameters with the backend.',
          });
          const response = await verifyLaunchHmac(location.search);
          await exchangeAndRedirect(response);
          return;
        }

        setState({
          kind: 'redirecting',
          title: 'Redirecting to secure Sapo login…',
          detail: 'This launch has no HMAC, so V1 starts OAuth SSO instead of accepting a direct session.',
        });
        const response = await startLogin({ storeDomain, redirectTo });
        await exchangeAndRedirect(response);
      } catch (error) {
        reportError('install-login', error);
        stripSensitiveUrlParams();
        setState({
          kind: 'error',
          title: hasLaunchHmac(location.search) ? 'Sapo launch was rejected' : 'Secure login failed',
          detail: getErrorMessage(error),
          canStartLogin: !hasLaunchHmac(location.search),
        });
      }
    };

    void run();
  }, [flowKey, location.search, navigate]);

  if (state.kind === 'error') {
    return (
      <Result
        className="center-card"
        status="error"
        title={state.title}
        subTitle={
          <Space direction="vertical" size="middle" className="full-width-space">
            <Paragraph>
              Invalid or stale signed launch parameters are fail-closed. Reopen the app from Sapo Admin to get a fresh signed launch.
            </Paragraph>
            <Alert showIcon type="error" message={state.detail} />
          </Space>
        }
        extra={[
          state.canStartLogin ? (
            <Button key="sso" type="primary" onClick={() => window.location.assign('/install/login')}>
              Start OAuth login
            </Button>
          ) : (
            <Button key="admin" disabled>
              Reopen from Sapo Admin
            </Button>
          ),
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
            Tokens stay server-side. The browser only exchanges a short-lived one-time handoff code for a HttpOnly cookie.
          </Text>
        </div>
      </Space>
    </Card>
  );
};
