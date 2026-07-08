import { useState } from 'react';
import {
  Button, Card, Input, Modal, Select, Space, Table, Tag, Typography, message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { AuthGate } from '../components/auth/auth-gate';
import {
  fetchQuestions, answerQuestion, updateQuestionStatus,
  type QnaItem,
} from '../api/qna-api';
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

const QnaTable = () => {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');
  const [answerModal, setAnswerModal] = useState<{ question: QnaItem } | null>(null);
  const [answerText, setAnswerText] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['questions', { status, page, sort }],
    queryFn: () => fetchQuestions({ page, limit: 20, status: status || undefined, sort }),
  });

  const statusMutation = useMutation({
    mutationFn: (args: { productId: string; questionId: string; status: string }) =>
      updateQuestionStatus(args.productId, args.questionId, args.status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      message.success('Question status updated');
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const answerMutation = useMutation({
    mutationFn: (args: { productId: string; questionId: string; answer: string }) =>
      answerQuestion(args.productId, args.questionId, args.answer),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      message.success('Answer posted');
      setAnswerModal(null);
      setAnswerText('');
    },
    onError: (err) => message.error(getErrorMessage(err)),
  });

  const columns: ColumnsType<QnaItem> = [
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
      title: 'Question',
      dataIndex: 'question',
      key: 'question',
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
      title: 'Answer',
      dataIndex: 'answer',
      key: 'answer',
      ellipsis: true,
      width: 200,
      render: (a: string | undefined) => a ? <Text ellipsis>{a}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 260,
      render: (_, record) => (
        <Space wrap size="small">
          <Button
            size="small"
            type="primary"
            disabled={record.status === 'approved'}
            loading={statusMutation.isPending}
            onClick={() => statusMutation.mutate({ productId: record.productId, questionId: record.questionId, status: 'approved' })}
          >
            Approve
          </Button>
          <Button
            size="small"
            disabled={record.status === 'hidden'}
            loading={statusMutation.isPending}
            onClick={() => statusMutation.mutate({ productId: record.productId, questionId: record.questionId, status: 'hidden' })}
          >
            Hide
          </Button>
          <Button
            size="small"
            onClick={() => {
              setAnswerText(record.answer || '');
              setAnswerModal({ question: record });
            }}
          >
            Answer
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card title="Questions & Answers">
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
            ]}
          />
        </Space>
        <Table
          rowKey="questionId"
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
        title={`Answer "${answerModal?.question.question?.slice(0, 60) ?? ''}${(answerModal?.question.question?.length ?? 0) > 60 ? '...' : ''}"`}
        open={!!answerModal}
        onCancel={() => { setAnswerModal(null); setAnswerText(''); }}
        onOk={() => {
          if (answerModal) {
            answerMutation.mutate({
              productId: answerModal.question.productId,
              questionId: answerModal.question.questionId,
              answer: answerText,
            });
          }
        }}
        confirmLoading={answerMutation.isPending}
      >
        <Input.TextArea
          rows={4}
          value={answerText}
          onChange={(e) => setAnswerText(e.target.value)}
          placeholder="Write your answer..."
        />
      </Modal>
    </Card>
  );
};

export const QnaPage = () => (
  <AuthGate>
    {() => <QnaTable />}
  </AuthGate>
);
