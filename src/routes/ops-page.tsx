import { Card, Row, Col, Button, Space, Typography, Tag, Statistic, message, Skeleton } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, SyncOutlined,
  DatabaseOutlined, ApiOutlined, CloudServerOutlined,
} from '@ant-design/icons';
import { AuthGate } from '../components/auth/auth-gate';
import { fetchHealth, resyncConfig, resyncWebhooks, backfillCatalog } from '../api/ops-api';
import { getErrorMessage } from '../lib/get-error-message';

const { Text } = Typography;

type HealthData = {
  db: 'ok' | 'degraded' | 'down';
  redis: 'ok' | 'degraded' | 'down';
  webhooks: 'ok' | 'degraded' | 'down';
  reviewCount: number;
  questionCount: number;
  productCount: number;
};

const healthIcon = (s: string) => {
  if (s === 'ok') return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
  if (s === 'degraded') return <WarningOutlined style={{ color: '#faad14' }} />;
  return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
};

const OpsContent = () => {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['ops-health'],
    queryFn: () => fetchHealth() as Promise<HealthData>,
    refetchInterval: 30_000,
  });

  const resyncConfigMutation = useMutation({
    mutationFn: resyncConfig,
    onSuccess: () => message.success('Config resynced'),
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const resyncWebhooksMutation = useMutation({
    mutationFn: resyncWebhooks,
    onSuccess: () => {
      message.success('Webhooks resynced');
      queryClient.invalidateQueries({ queryKey: ['ops-health'] });
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const backfillMutation = useMutation({
    mutationFn: backfillCatalog,
    onSuccess: () => {
      message.success('Catalog backfill triggered');
      queryClient.invalidateQueries({ queryKey: ['ops-health'] });
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  if (isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (isError) return <Text type="danger">{getErrorMessage(error)}</Text>;

  const health = data!;

  return (
    <Space direction="vertical" size="large" className="full-width-space">
      <Card title="Service Health">
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}>
            <Card size="small">
              <Space align="center">
                {healthIcon(health.db)}
                <div>
                  <div className="status-card-label">Database</div>
                  <div className="status-card-value">
                    <Tag color={health.db === 'ok' ? 'green' : health.db === 'degraded' ? 'gold' : 'red'}>
                      {health.db.toUpperCase()}
                    </Tag>
                  </div>
                </div>
              </Space>
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card size="small">
              <Space align="center">
                {healthIcon(health.redis)}
                <div>
                  <div className="status-card-label">Redis</div>
                  <div className="status-card-value">
                    <Tag color={health.redis === 'ok' ? 'green' : health.redis === 'degraded' ? 'gold' : 'red'}>
                      {health.redis.toUpperCase()}
                    </Tag>
                  </div>
                </div>
              </Space>
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card size="small">
              <Space align="center">
                {healthIcon(health.webhooks)}
                <div>
                  <div className="status-card-label">Webhooks</div>
                  <div className="status-card-value">
                    <Tag color={health.webhooks === 'ok' ? 'green' : health.webhooks === 'degraded' ? 'gold' : 'red'}>
                      {health.webhooks.toUpperCase()}
                    </Tag>
                  </div>
                </div>
              </Space>
            </Card>
          </Col>
        </Row>
      </Card>

      <Card title="Data Counts">
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}>
            <Card size="small">
              <Statistic title="Reviews" value={health.reviewCount} prefix={<CloudServerOutlined />} />
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card size="small">
              <Statistic title="Questions" value={health.questionCount} prefix={<CloudServerOutlined />} />
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card size="small">
              <Statistic title="Products" value={health.productCount} prefix={<DatabaseOutlined />} />
            </Card>
          </Col>
        </Row>
      </Card>

      <Card title="Operations">
        <Space wrap>
          <Button
            icon={<SyncOutlined />}
            onClick={() => resyncConfigMutation.mutate()}
            loading={resyncConfigMutation.isPending}
          >
            Resync Config
          </Button>
          <Button
            icon={<ApiOutlined />}
            onClick={() => resyncWebhooksMutation.mutate()}
            loading={resyncWebhooksMutation.isPending}
          >
            Resync Webhooks
          </Button>
          <Button
            icon={<DatabaseOutlined />}
            onClick={() => backfillMutation.mutate()}
            loading={backfillMutation.isPending}
            type="primary"
          >
            Backfill Catalog
          </Button>
        </Space>
      </Card>
    </Space>
  );
};

export const OpsPage = () => (
  <AuthGate>
    {() => <OpsContent />}
  </AuthGate>
);
