import { Card, Col, Row, Skeleton, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  CommentOutlined, MessageOutlined, PercentageOutlined, StarFilled,
} from '@ant-design/icons';
import { AuthGate } from '../components/auth/auth-gate';
import { fetchDashboardOverview } from '../api/dashboard-api';
import { getErrorMessage } from '../lib/get-error-message';

const { Text } = Typography;

type DashboardData = {
  totalReviews: number;
  avgRating: number;
  totalQuestions: number;
  responseRate: number;
  recentReviews: Array<{
    reviewId: string;
    productTitle?: string;
    author: string;
    rating: number;
    content: string;
    status: string;
    createdAt: number;
  }>;
  recentQuestions: Array<{
    questionId: string;
    productTitle?: string;
    author: string;
    question: string;
    status: string;
    createdAt: number;
  }>;
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'gold',
  approved: 'green',
  hidden: 'default',
  spam: 'red',
};

export const DashboardContent = () => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: () => fetchDashboardOverview() as Promise<DashboardData>,
  });

  if (isLoading) {
    return (
      <Space direction="vertical" size="large" className="full-width-space">
        <Skeleton active paragraph={{ rows: 2 }} />
        <Skeleton active paragraph={{ rows: 4 }} />
      </Space>
    );
  }

  if (isError) {
    return <Text type="danger">{getErrorMessage(error)}</Text>;
  }

  const overview = data!;

  const reviewCols = [
    { title: 'Product', dataIndex: 'productTitle', key: 'product', ellipsis: true, render: (t: string | undefined) => t || '-' },
    { title: 'Author', dataIndex: 'author', key: 'author', width: 120 },
    { title: 'Rating', dataIndex: 'rating', key: 'rating', width: 80, render: (r: number) => `${r}/5` },
    { title: 'Content', dataIndex: 'content', key: 'content', ellipsis: true, width: 220 },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (s: string) => <Tag color={STATUS_COLOR[s] || 'default'}>{s}</Tag> },
  ];

  const qnaCols = [
    { title: 'Product', dataIndex: 'productTitle', key: 'product', ellipsis: true, render: (t: string | undefined) => t || '-' },
    { title: 'Author', dataIndex: 'author', key: 'author', width: 120 },
    { title: 'Question', dataIndex: 'question', key: 'question', ellipsis: true, width: 280 },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (s: string) => <Tag color={STATUS_COLOR[s] || 'default'}>{s}</Tag> },
  ];

  return (
    <Space direction="vertical" size="large" className="full-width-space">
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="Total Reviews" value={overview.totalReviews} prefix={<CommentOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="Average Rating" value={overview.avgRating} precision={1} prefix={<StarFilled style={{ color: '#faad14' }} />} suffix="/5" />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="Questions" value={overview.totalQuestions} prefix={<MessageOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="Response Rate" value={overview.responseRate} suffix="%" precision={0} prefix={<PercentageOutlined />} />
          </Card>
        </Col>
      </Row>

      <Card title="Recent Reviews">
        <Table
          rowKey="reviewId"
          columns={reviewCols}
          dataSource={overview.recentReviews}
          pagination={false}
          size="small"
          scroll={{ x: 600 }}
        />
      </Card>

      <Card title="Recent Questions">
        <Table
          rowKey="questionId"
          columns={qnaCols}
          dataSource={overview.recentQuestions}
          pagination={false}
          size="small"
          scroll={{ x: 600 }}
        />
      </Card>
    </Space>
  );
};

export const DashboardPage = () => (
  <AuthGate>
    {() => <DashboardContent />}
  </AuthGate>
);
