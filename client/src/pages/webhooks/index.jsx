import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Divider,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ApiOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
} from "@ant-design/icons";
import AdminLayout from "../../components/layout/AdminLayout";
import {
  createOutboundEndpoint,
  deleteOutboundEndpoint,
  fetchOutboundDeliveries,
  fetchOutboundEndpoints,
  fetchOutboundEvents,
  rotateOutboundSecret,
  testOutboundEndpoint,
  updateOutboundEndpoint,
} from "../../common/ApiService";
import { getStoreDomain } from "../../common/AuthStorage";
import { getErrorMessage } from "../../common/getErrorMessage";
import { shopQueryKeys } from "../../common/queryKeys";
import { toast } from "../../common/toast";
import Link from "../../components/StoreLink";

const { Title, Text, Paragraph } = Typography;

const EVENT_LABELS = {
  "review.created": "Đánh giá mới",
  "review.approved": "Đánh giá được duyệt",
  "review.updated": "Đánh giá được sửa",
  "review.replied": "Shop phản hồi",
  "review.deleted": "Đánh giá bị xoá",
  "qna.created": "Câu hỏi mới",
  "qna.answered": "Câu hỏi được trả lời",
};

const eventLabel = (event) => EVENT_LABELS[event] || event;

const statusTag = (status) => {
  const map = {
    delivered: { color: "success", label: "Đã gửi" },
    pending: { color: "processing", label: "Đang chờ" },
    failed: { color: "error", label: "Lỗi" },
  };
  const hit = map[status] || { color: "default", label: status };
  return <Tag color={hit.color}>{hit.label}</Tag>;
};

const formatTime = (value) => {
  if (!value) return "-";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "-";
  return time.toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const WebhooksPage = () => {
  const storeDomain = getStoreDomain();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [secretInfo, setSecretInfo] = useState(null);
  const [deliveriesFor, setDeliveriesFor] = useState(null);
  const [deliveriesPage, setDeliveriesPage] = useState(0);

  const { data: endpoints, isLoading } = useQuery({
    queryKey: shopQueryKeys.outboundEndpoints(storeDomain),
    queryFn: fetchOutboundEndpoints,
    enabled: !!storeDomain,
  });
  const { data: events } = useQuery({
    queryKey: shopQueryKeys.outboundEvents(storeDomain),
    queryFn: fetchOutboundEvents,
    enabled: !!storeDomain,
  });
  const { data: deliveries, isFetching: deliveriesLoading } = useQuery({
    queryKey: shopQueryKeys.outboundDeliveries(storeDomain, deliveriesFor?.id, deliveriesPage),
    queryFn: () => fetchOutboundDeliveries(deliveriesFor.id, { page: deliveriesPage, size: 20 }),
    enabled: !!storeDomain && !!deliveriesFor,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: shopQueryKeys.outboundEndpoints(storeDomain) });

  const saveMutation = useMutation({
    mutationFn: (values) => (editing ? updateOutboundEndpoint(editing.id, values) : createOutboundEndpoint(values)),
    onSuccess: (data) => {
      refresh();
      setFormOpen(false);
      setEditing(null);
      if (data?.secret) {
        setSecretInfo({ secret: data.secret, url: data.endpoint?.url || "webhook" });
      } else {
        toast.success("Đã cập nhật webhook");
      }
    },
    onError: (error) => toast.error(getErrorMessage(error, "Lưu webhook thất bại")),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }) => updateOutboundEndpoint(id, { active }),
    onSuccess: refresh,
    onError: (error) => toast.error(getErrorMessage(error, "Không đổi được trạng thái")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteOutboundEndpoint(id),
    onSuccess: () => {
      refresh();
      toast.success("Đã xoá webhook");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Xoá webhook thất bại")),
  });

  const rotateMutation = useMutation({
    mutationFn: (endpoint) => rotateOutboundSecret(endpoint.id),
    onSuccess: (data, endpoint) => {
      refresh();
      setSecretInfo({ secret: data.secret, url: endpoint.url });
    },
    onError: (error) => toast.error(getErrorMessage(error, "Xoay khoá thất bại")),
  });

  const testMutation = useMutation({
    mutationFn: (endpoint) => testOutboundEndpoint(endpoint.id),
    onSuccess: (data) => {
      if (data?.delivered) {
        toast.success(`Đã gửi thử tới ${data.url || "webhook"}`);
      } else {
        toast.error(data?.error || "Webhook không phản hồi thành công");
      }
    },
    onError: (error) => toast.error(getErrorMessage(error, "Gửi thử thất bại")),
  });

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ url: "", description: "", events: [], active: true });
    setFormOpen(true);
  };

  const openEdit = (endpoint) => {
    setEditing(endpoint);
    form.setFieldsValue({
      url: endpoint.url,
      description: endpoint.description || "",
      events: endpoint.events,
      active: endpoint.active,
    });
    setFormOpen(true);
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secretInfo.secret);
      toast.success("Đã sao chép khoá ký");
    } catch {
      toast.error("Trình duyệt chặn sao chép, hãy chọn và copy thủ công");
    }
  };

  return (
    <AdminLayout>
      <Breadcrumb
        items={[{ title: <Link to="/">Tổng quan</Link> }, { title: "Tích hợp" }]}
        style={{ marginBottom: 16 }}
      />
      <Flex justify="space-between" align="center" gap={12} wrap style={{ marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Tích hợp webhook</Title>
          <Text type="secondary">
            Đẩy sự kiện đánh giá và hỏi đáp sang hệ thống của bạn ngay khi chúng xảy ra.
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Thêm webhook
        </Button>
      </Flex>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Cách xác thực"
        description={
          <span>
            Mỗi lần gửi, hệ thống kèm header <Text code>x-f1genz-signature</Text> = <Text code>sha256=…</Text>,
            là HMAC-SHA256 của đúng nội dung body với khoá ký của webhook. So sánh bằng timing-safe để chắc chắn
            request đến từ F1GENZ.
          </span>
        }
      />

      {isLoading ? (
        <Flex justify="center" style={{ padding: 48 }}><Spin /></Flex>
      ) : !endpoints?.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Chưa có webhook nào. Thêm webhook để nhận sự kiện đánh giá."
        >
          <Button type="primary" onClick={openCreate}>Thêm webhook đầu tiên</Button>
        </Empty>
      ) : (
        <Flex vertical gap={12}>
          {endpoints.map((endpoint) => (
            <Card
              key={endpoint.id}
              size="small"
              title={
                <Flex align="center" gap={8} wrap>
                  <ApiOutlined />
                  <Text strong className="f1g-break">{endpoint.url}</Text>
                  {!endpoint.active && <Tag>Đang tắt</Tag>}
                </Flex>
              }
              extra={
                <Space size={4} wrap>
                  <Switch
                    size="small"
                    checked={endpoint.active}
                    aria-label={`Bật webhook ${endpoint.url}`}
                    onChange={(active) => toggleMutation.mutate({ id: endpoint.id, active })}
                  />
                  <Button size="small" onClick={() => openEdit(endpoint)}>Sửa</Button>
                  <Button
                    size="small"
                    icon={<SendOutlined />}
                    loading={testMutation.isPending}
                    onClick={() => testMutation.mutate(endpoint)}
                  >
                    Gửi thử
                  </Button>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={rotateMutation.isPending}
                    onClick={() => rotateMutation.mutate(endpoint)}
                  >
                    Xoay khoá
                  </Button>
                  <Tooltip title="20 lượt gửi gần nhất">
                    <Button
                      size="small"
                      icon={<HistoryOutlined />}
                      onClick={() => {
                        setDeliveriesPage(0);
                        setDeliveriesFor(endpoint);
                      }}
                    >
                      Lượt gửi
                    </Button>
                  </Tooltip>
                  <Popconfirm
                    title="Xoá webhook này?"
                    description={`Hệ thống sẽ ngừng gửi sự kiện tới ${endpoint.url}. Hành động không hoàn tác được.`}
                    okText="Xoá"
                    okButtonProps={{ danger: true }}
                    cancelText="Hủy"
                    onConfirm={() => deleteMutation.mutate(endpoint.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      Xoá
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              {endpoint.description ? (
                <Paragraph type="secondary" style={{ marginBottom: 8 }}>{endpoint.description}</Paragraph>
              ) : null}
              <Flex gap={4} wrap>
                {endpoint.events.map((event) => (
                  <Tag key={event}>{eventLabel(event)}</Tag>
                ))}
              </Flex>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
                Tạo lúc {formatTime(endpoint.createdAt)} · Cập nhật {formatTime(endpoint.updatedAt)}
              </Text>
            </Card>
          ))}
        </Flex>
      )}

      <Modal
        open={formOpen}
        title={editing ? "Sửa webhook" : "Thêm webhook"}
        okText={editing ? "Lưu thay đổi" : "Tạo webhook"}
        cancelText="Hủy"
        confirmLoading={saveMutation.isPending}
        onCancel={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item
            name="url"
            label="URL nhận sự kiện"
            rules={[
              { required: true, message: "Nhập URL https của hệ thống bạn" },
              { pattern: /^https:\/\/.+/, message: "URL phải bắt đầu bằng https://" },
            ]}
          >
            <Input placeholder="https://example.com/hooks/f1genz" />
          </Form.Item>
          <Form.Item name="description" label="Ghi chú">
            <Input placeholder="Ví dụ: CRM nội bộ" maxLength={200} />
          </Form.Item>
          <Form.Item
            name="events"
            label="Sự kiện cần nhận"
            rules={[{ required: true, message: "Chọn ít nhất một sự kiện" }]}
          >
            <Checkbox.Group
              options={(events || Object.keys(EVENT_LABELS)).map((event) => ({
                value: event,
                label: eventLabel(event),
              }))}
            />
          </Form.Item>
          <Form.Item name="active" label="Kích hoạt" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!secretInfo}
        title="Khoá ký webhook"
        okText="Tôi đã lưu khoá"
        cancelButtonProps={{ style: { display: "none" } }}
        onOk={() => setSecretInfo(null)}
        onCancel={() => setSecretInfo(null)}
      >
        <Alert
          type="warning"
          showIcon
          message="Khoá chỉ hiển thị một lần"
          description="Lưu khoá ở nơi an toàn để xác thực chữ ký. Nếu mất, hãy xoay khoá mới."
          style={{ marginBottom: 12 }}
        />
        <Text type="secondary">Webhook: {secretInfo?.url}</Text>
        <Divider style={{ margin: "8px 0" }} />
        <Flex gap={8}>
          <Input readOnly value={secretInfo?.secret || ""} onFocus={(event) => event.target.select()} />
          <Button onClick={copySecret}>Sao chép</Button>
        </Flex>
      </Modal>

      <Modal
        open={!!deliveriesFor}
        title={`Lượt gửi · ${deliveriesFor?.url || ""}`}
        footer={null}
        width={880}
        onCancel={() => setDeliveriesFor(null)}
      >
        <Table
          size="small"
          rowKey="id"
          loading={deliveriesLoading}
          dataSource={deliveries?.items || []}
          pagination={{
            current: deliveriesPage + 1,
            pageSize: deliveries?.pageSize || 20,
            total: deliveries?.total || 0,
            onChange: (page) => setDeliveriesPage(page - 1),
            showSizeChanger: false,
          }}
          columns={[
            { title: "Sự kiện", dataIndex: "event", render: (value) => eventLabel(value) },
            { title: "Trạng thái", dataIndex: "status", render: statusTag },
            { title: "Lần thử", dataIndex: "attempts", width: 80 },
            {
              title: "Mã phản hồi",
              dataIndex: "responseStatus",
              width: 110,
              render: (value) => (value ? value : "-"),
            },
            {
              title: "Lỗi gần nhất",
              dataIndex: "lastError",
              render: (value) => (value ? <Text type="danger" className="f1g-break">{value}</Text> : "-"),
            },
            {
              title: "Thời điểm",
              dataIndex: "createdAt",
              width: 160,
              render: (value) => formatTime(value),
            },
          ]}
        />
      </Modal>
    </AdminLayout>
  );
};

export default WebhooksPage;
