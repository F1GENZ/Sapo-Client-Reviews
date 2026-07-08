import { useState } from 'react';
import {
  Button, Card, Input, Modal, Select, Space, Table, Tag, Typography, message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { AuthGate } from '../components/auth/auth-gate';
import {
  fetchReviews, replyToReview, updateReviewStatus, pinReview,
  type ReviewItem,
} from '../api/reviews-api';
import { getErrorMessage } from '../lib/get-error-message';

const { Text } = Typography;

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'hidden', label: 'Hidden' },
  { key: 'spam', label: 'Spam' },
];

const STATUS_COLOR: Record<string, string> = {
  pending: 'gold',
  approved: 'green',
  hidden: 'default',
  spam: 'red',
};

const ReviewsTable = () => {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');
  const [replyModal, setReplyModal] = useState<{ review: ReviewItem } | null>(null);
  const [replyText, setReplyText] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reviews', { status, page, sort }],
    queryFn: () => fetchReviews({ page, limit: 20, status: status || undefined, sort }),
  });

  const statusMutation = useMutation({
    mutationFn: (args: { productId: string; reviewId: string; status: string }) =>
      updateReviewStatus(args.productId, args.reviewId, args.status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
      message.success('Review status updated');
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const replyMutation = useMutation({
    mutationFn: (args: { productId: string; reviewId: string; reply: string }) =>
      replyToReview(args.productId, args.reviewId, args.reply),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
      message.success('Reply sent');
      setReplyModal(null);
      setReplyText('');
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const pinMutation = useMutation({
    mutationFn: (args: { productId: string; reviewId: string; pinned: boolean }) =>
      pinReview(args.productId, args.reviewId, args.pinned),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
      message.success('Pin toggled');
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const columns: ColumnsType<ReviewItem> = [
    {
      title: 'Product',
      dataIndex: 'productTitle',
      key: 'product',
      ellipsis: true,
      render: (title: string | undefined) => title || '-',
    },
    {
      title: 'Author',
      dataIndex: 'author',
      key: 'author',
      width: 140,
    },
    {
      title: 'Rating',
      dataIndex: 'rating',
      key: 'rating',
      width: 80,
      render: (r: number) => `${r}/5`,
    },
    {
      title: 'Content',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      width: 260,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => <Tag color={STATUS_COLOR[s] || 'default'}>{s}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 320,
      render: (_, record) => (
        <Space wrap size="small">
          <Button
            size="small"
            type="primary"
            disabled={record.status === 'approved'}
            loading={statusMutation.isPending}
            onClick={() => statusMutation.mutate({ productId: record.productId, reviewId: record.reviewId, status: 'approved' })}
          >
            Approve
          </Button>
          <Button
            size="small"
            disabled={record.status === 'hidden'}
            loading={statusMutation.isPending}
            onClick={() => statusMutation.mutate({ productId: record.productId, reviewId: record.reviewId, status: 'hidden' })}
          >
            Hide
          </Button>
          <Button
            size="small"
            danger
            disabled={record.status === 'spam'}
            loading={statusMutation.isPending}
            onClick={() => statusMutation.mutate({ productId: record.productId, reviewId: record.reviewId, status: 'spam' })}
          >
            Spam
          </Button>
          <Button
            size="small"
            onClick={() => {
              setReplyText(record.reply || '');
              setReplyModal({ review: record });
            }}
          >
            Reply
          </Button>
          <Button
            size="small"
            type={record.pinned ? 'primary' : 'default'}
            loading={pinMutation.isPending}
            onClick={() => pinMutation.mutate({ productId: record.productId, reviewId: record.reviewId, pinned: !record.pinned })}
          >
            {record.pinned ? 'Unpin' : 'Pin'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card title="Reviews">
      <Space direction="vertical" size="middle" className="full-width-space">
        <Space wrap>
          {STATUS_TABS.map((tab) => (
            <Button
              key={tab.key}
              type={status === tab.key ? 'primary' : 'default'}
              onClick={() => { setStatus(tab.key); setPage(1); }}
            >
              {tab.label}
            </Button>
          ))}
          <Select
            value={sort}
            onChange={(v) => { setSort(v); setPage(1); }}
            style={{ width: 140 }}
            options={[
              { value: 'newest', label: 'Newest' },
              { value: 'oldest', label: 'Oldest' },
              { value: 'highest', label: 'Highest rated' },
              { value: 'lowest', label: 'Lowest rated' },
            ]}
          />
        </Space>
        <Table
          rowKey="reviewId"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isLoading}
          pagination={{
            current: page,
            pageSize: 20,
            total: data?.total ?? 0,
            showSizeChanger: false,
            onChange: (p) => setPage(p),
          }}
          scroll={{ x: 900 }}
        />
        {isError && (
          <Text type="danger">{getErrorMessage(error)}</Text>
        )}
      </Space>

      <Modal
        title={`Reply to review by ${replyModal?.review.author ?? ''}`}
        open={!!replyModal}
        onCancel={() => { setReplyModal(null); setReplyText(''); }}
        onOk={() => {
          if (replyModal) {
            replyMutation.mutate({
              productId: replyModal.review.productId,
              reviewId: replyModal.review.reviewId,
              reply: replyText,
            });
          }
        }}
        confirmLoading={replyMutation.isPending}
      >
        <Input.TextArea
          rows={4}
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Write your reply..."
        />
      </Modal>
    </Card>
  );
};

export const ReviewsPage = () => (
  <AuthGate>
    {() => <ReviewsTable />}
  </AuthGate>
);
