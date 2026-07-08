import { Card, Form, Select, Space, Typography, Alert, Button, Skeleton, message, Descriptions, Badge } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api/api-client';
import { AuthGate } from '../components/auth/auth-gate';
import { getStoredDomain } from '../lib/store-context';
import { getErrorMessage } from '../lib/get-error-message';
import { type SessionProbeResponse } from '../api/auth-api';

const { Text, Title, Paragraph } = Typography;

type WidgetConfig = {
  formPhoneMode: 'required' | 'optional' | 'hidden';
  reviewQnaDisplayMode: 'tabs' | 'accordion';
};

type SettingsData = {
  widget: WidgetConfig;
  webhookStatus: string;
};

const fetchSettings = () =>
  apiClient.get<SettingsData>('/admin/settings').then(r => r.data);

const saveSettings = (body: { widget: Partial<WidgetConfig> }) =>
  apiClient.patch('/admin/settings', body).then(r => r.data);

const SettingsContent = ({ session }: { session: SessionProbeResponse }) => {
  const queryClient = useQueryClient();
  const [form] = Form.useForm();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const mutation = useMutation({
    mutationFn: saveSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      message.success('Settings saved');
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  if (isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (isError) return <Text type="danger">{getErrorMessage(error)}</Text>;

  const settings = data!;
  const domain = getStoredDomain() || session.storeDomain;

  return (
    <Space direction="vertical" size="large" className="full-width-space">
      <Card title="Widget Configuration">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            formPhoneMode: settings.widget.formPhoneMode || 'optional',
            reviewQnaDisplayMode: settings.widget.reviewQnaDisplayMode || 'tabs',
          }}
          onFinish={(values) =>
            mutation.mutate({ widget: values as Partial<WidgetConfig> })
          }
        >
          <Form.Item
            label="Phone field mode"
            name="formPhoneMode"
            tooltip="Controls whether the phone field is shown in the review form"
          >
            <Select
              options={[
                { value: 'required', label: 'Required' },
                { value: 'optional', label: 'Optional' },
                { value: 'hidden', label: 'Hidden' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="Review/Q&A display mode"
            name="reviewQnaDisplayMode"
            tooltip="How reviews and Q&A are displayed on the storefront"
          >
            <Select
              options={[
                { value: 'tabs', label: 'Tabs' },
                { value: 'accordion', label: 'Accordion' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={mutation.isPending}>
              Save Settings
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="Storefront Installation">
        <Space direction="vertical" size="middle" className="full-width-space">
          <Alert
            type="info"
            showIcon
            message="Add the following snippet to your Sapo theme to display reviews."
          />
          <div>
            <Title level={5}>Reviews widget snippet</Title>
            <Paragraph>
              Paste this <code>.bwt</code> snippet where you want the review widget to appear
              (e.g., in <code>product.bwt</code>):
            </Paragraph>
            <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: 13 }}>
{`{%- render 'f1genz-review-widget' -%}`}
            </pre>
          </div>
          <div>
            <Title level={5}>Q&A widget snippet</Title>
            <Paragraph>
              Paste this snippet where you want the Q&A widget to appear:
            </Paragraph>
            <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: 13 }}>
{`{%- render 'f1genz-qna-widget' -%}`}
            </pre>
          </div>
        </Space>
      </Card>

      <Card title="System Status">
        <Space direction="vertical" size="middle" className="full-width-space">
          <Descriptions bordered column={{ xs: 1, sm: 1, md: 2 }}>
            <Descriptions.Item label="Store Domain">
              <Text copyable>{domain}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Install Status">
              <Badge
                status={session.status === 'active' ? 'success' : 'warning'}
                text={session.status}
              />
            </Descriptions.Item>
            <Descriptions.Item label="Webhook Status">
              <Badge
                status={
                  session.webhookStatus === 'registered' ? 'success'
                  : session.webhookStatus === 'degraded' ? 'warning'
                  : 'error'
                }
                text={session.webhookStatus}
              />
            </Descriptions.Item>
            <Descriptions.Item label="Widget Webhook">
              <Badge
                status={
                  settings.webhookStatus === 'registered' ? 'success'
                  : settings.webhookStatus === 'degraded' ? 'warning'
                  : 'error'
                }
                text={settings.webhookStatus}
              />
            </Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>
    </Space>
  );
};

export const SettingsPage = () => (
  <AuthGate>
    {(session) => <SettingsContent session={session} />}
  </AuthGate>
);
