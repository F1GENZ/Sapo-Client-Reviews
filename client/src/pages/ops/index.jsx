import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Collapse,
  Col,
  Empty,
  Flex,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import {
  ApiOutlined,
  BuildOutlined,
  CheckCircleOutlined,
  HeartOutlined,
  HistoryOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import AdminLayout from "../../components/layout/AdminLayout";
import {
  exportOpsDiagnostics,
  fetchOpsHealth,
  resyncOpsConfig,
  resyncOpsWebhooks,
  backfillOpsCatalog,
  syncOpsMetafields,
  syncOpsOrders,
} from "../../common/ApiService";
import { toast } from "../../common/toast";
import { getErrorMessage } from "../../common/getErrorMessage";
import { getStoreDomain } from "../../common/AuthStorage";
import { shopQueryKeys } from "../../common/queryKeys";
import Link from "../../components/StoreLink";

const { Title, Text } = Typography;

const formatTime = (value) => {
  const numeric = Number(value);
  const timestamp = numeric > 0 ? numeric : Date.parse(value);
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const formatNumber = (value) => Number(value || 0).toLocaleString("vi-VN");

const webhookRowStatus = {
  processed: "Đã xử lý",
  failed: "Lỗi",
  processing: "Đang xử lý",
  received: "Đã nhận",
  ignored: "Bỏ qua",
};

const statusColor = {
  processed: "success",
  failed: "error",
  processing: "processing",
  received: "processing",
  ignored: "default",
};

const NumberCard = ({ label, value, suffix, icon }) => {
  const { token } = theme.useToken();
  return (
    <Card size="small" styles={{ body: { padding: 16 } }}>
      <Flex align="center" gap={12}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: token.colorFillSecondary,
            color: token.colorPrimary,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {label}
          </Text>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15 }}>
            {formatNumber(value)}
            {suffix && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
                {suffix}
              </Text>
            )}
          </div>
        </div>
      </Flex>
    </Card>
  );
};

const ServiceCard = ({ title, state = "ok", icon, description, detail }) => {
  const { token } = theme.useToken();
  const tone = {
    ok: { bg: token.colorSuccessBg, fg: token.colorSuccessText, badge: "success", text: "OK" },
    warn: { bg: token.colorWarningBg, fg: token.colorWarningText, badge: "warning", text: "Cần chú ý" },
    error: { bg: token.colorErrorBg, fg: token.colorErrorText, badge: "error", text: "Lỗi" },
    neutral: { bg: token.colorFillSecondary, fg: token.colorTextSecondary, badge: "default", text: "Chưa có dữ liệu" },
  }[state] || {};
  return (
    <Card size="small" styles={{ body: { padding: 16, minHeight: 118 } }}>
      <Flex justify="space-between" align="flex-start" gap={12} wrap="wrap">
        <Space align="start" size={12}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              background: tone.bg,
              color: tone.fg,
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
          <div>
            <Text strong>{title}</Text>
            <div
              style={{
                color: token.colorTextSecondary,
                fontSize: 12,
                marginTop: 3,
              }}
            >
              {description}
            </div>
          </div>
        </Space>
        <Badge status={tone.badge} text={tone.text} />
      </Flex>
      {detail && (
        <Text
          type="secondary"
          style={{
            display: "block",
            marginTop: 12,
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={detail}
        >
          {detail}
        </Text>
      )}
    </Card>
  );
};

const OpsPage = () => {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const storeDomain = getStoreDomain();
  const [webhookResult, setWebhookResult] = useState(null);
  const queryKey = shopQueryKeys.opsHealth(storeDomain);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: fetchOpsHealth,
    enabled: !!storeDomain,
    refetchInterval: 30_000,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const resyncConfig = useMutation({
    mutationFn: resyncOpsConfig,
    onSuccess: async (result) => {
      if (result?.ok === false || result?.configError) {
        toast.error(`Resync config có lỗi: ${result.configError || "không rõ nguyên nhân"}`);
      } else {
        toast.success("Đã đồng bộ lại cấu hình storefront");
      }
      await invalidate();
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, "Resync config thất bại")),
  });

  const resyncWebhooks = useMutation({
    mutationFn: resyncOpsWebhooks,
    onSuccess: async (result) => {
      setWebhookResult(result);
      if (result?.status === "registered") {
        toast.success("Đã đăng ký lại webhook");
      } else {
        toast.error(`Đăng ký webhook ${result?.status || "thất bại"}${result?.error ? `: ${result.error}` : ""}`);
      }
      await invalidate();
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, "Resync webhook thất bại")),
  });

  const backfillCatalog = useMutation({
    mutationFn: backfillOpsCatalog,
    onSuccess: async (result) => {
      if (result?.ok === false) {
        toast.error(`Backfill dừng sớm (${result.stopReason || "không rõ"}): đã sync ${result.synced || 0} sản phẩm`);
      } else {
        toast.success(`Đã sync ${result?.synced || 0} sản phẩm`);
      }
      await invalidate();
    },
    onError: (error) => {
      const body = error?.response?.data;
      if (body?.code === "backfill_rate_limited") {
        toast.error(`Backfill vừa chạy, thử lại sau ${body.retryAfterSeconds || 0} giây`);
      } else if (body?.code === "backfill_in_progress") {
        toast.error("Backfill đang chạy cho cửa hàng này");
      } else {
        toast.error(getErrorMessage(error, "Backfill catalog thất bại"));
      }
    },
  });

  const syncOrders = useMutation({
    mutationFn: () => syncOpsOrders({ pages: 1 }),
    onSuccess: async (result) => {
      toast.success(
        `Đã đồng bộ ${result?.orders || 0} đơn (${result?.resolved || 0} khách khớp, ${result?.skipped || 0} bỏ qua)`,
      );
      await invalidate();
    },
    onError: (error) => toast.error(getErrorMessage(error, "Đồng bộ đơn hàng thất bại")),
  });

  const syncMetafields = useMutation({
    mutationFn: syncOpsMetafields,
    onSuccess: async (result) => {
      toast.success(`Đã đẩy ${result?.synced || 0} metafield, ${result?.queued || 0} xếp hàng`);
      await invalidate();
    },
    onError: (error) => toast.error(getErrorMessage(error, "Đồng bộ metafield thất bại")),
  });

  const diagnostics = useMutation({
    mutationFn: exportOpsDiagnostics,
    onSuccess: (payload) => {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `f1genz-chan-doan-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Đã tải gói chẩn đoán");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Xuất chẩn đoán thất bại")),
  });

  const webhookRows = Array.isArray(data?.webhooks?.latest)
    ? data.webhooks.latest
    : [];
  const webhookFailed =
    data?.webhooks?.totals?.find?.((item) => item.status === "failed")?.count ||
    0;
  const webhookProcessed =
    data?.webhooks?.totals?.find?.((item) => item.status === "processed")?.count ||
    0;

  const statusLabel = {
    active: "Đang hoạt động",
    needs_reinstall: "Cần cài lại",
    uninstalled: "Đã gỡ",
    trial: "Dùng thử",
    unknown: "Không xác định",
  };

  const webhookStatusLabel = {
    registered: "Đã đăng ký",
    not_configured: "Chưa đăng ký",
    failed: "Đăng ký lỗi",
    pending: "Đang đăng ký",
  };

  return (
    <AdminLayout>
      <Breadcrumb
        items={[{ title: <Link to="/">Tổng quan</Link> }, { title: "Vận hành" }]}
        style={{ marginBottom: 16 }}
      />
      <Flex
        justify="space-between"
        align="center"
        gap={16}
        wrap="wrap"
        style={{ marginBottom: 16 }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Vận hành
          </Title>
          <Text type="secondary">
            Trạng thái app trên store và các thao tác đồng bộ với Sapo.
          </Text>
        </div>
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={isFetching}
            onClick={() => refetch()}
          >
            Làm mới
          </Button>
        </Space>
      </Flex>

      <Collapse
        style={{ marginBottom: 16, background: "#fff" }}
        items={[
          {
            key: "tools",
            label: "Công cụ vận hành (thay đổi dữ liệu)",
            children: (
              <Space wrap size={8}>
                <Popconfirm
                  title="Đồng bộ lại cấu hình storefront?"
                  description="Đẩy widget config và metafield cấu hình xuống store, khoảng 10–30 giây."
                  okText="Đồng bộ"
                  cancelText="Hủy"
                  onConfirm={() => resyncConfig.mutate()}
                >
                  <Button icon={<SettingOutlined />} loading={resyncConfig.isPending}>
                    Đồng bộ lại cấu hình
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="Đăng ký lại webhook với Sapo?"
                  description="Xoá và tạo lại webhook cho store, khoảng 10–20 giây."
                  okText="Đăng ký lại"
                  cancelText="Hủy"
                  onConfirm={() => resyncWebhooks.mutate()}
                >
                  <Button icon={<SafetyCertificateOutlined />} loading={resyncWebhooks.isPending}>
                    Đăng ký lại webhook
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="Nạp lại danh mục sản phẩm?"
                  description="Quét lại sản phẩm từ Sapo, tối đa 5 trang mỗi lần và có giới hạn tần suất."
                  okText="Nạp lại"
                  cancelText="Hủy"
                  onConfirm={() => backfillCatalog.mutate()}
                >
                  <Button icon={<BuildOutlined />} loading={backfillCatalog.isPending}>
                    Nạp lại danh mục
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="Đồng bộ đơn hàng gần đây?"
                  description="Đọc 1 trang 50 đơn mới nhất để xác định khách đã mua hàng."
                  okText="Đồng bộ"
                  cancelText="Hủy"
                  onConfirm={() => syncOrders.mutate()}
                >
                  <Button icon={<ApiOutlined />} loading={syncOrders.isPending}>
                    Đồng bộ đơn hàng
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="Đẩy lại toàn bộ metafield?"
                  description="Ghi lại điểm đánh giá cho mọi sản phẩm đang hoạt động."
                  okText="Đẩy lại"
                  cancelText="Hủy"
                  onConfirm={() => syncMetafields.mutate()}
                >
                  <Button icon={<ReloadOutlined />} loading={syncMetafields.isPending}>
                    Đẩy lại metafield
                  </Button>
                </Popconfirm>
                <Button
                  icon={<HistoryOutlined />}
                  loading={diagnostics.isPending}
                  onClick={() => diagnostics.mutate()}
                >
                  Xuất gói chẩn đoán
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Card
        loading={isLoading}
        styles={{ body: { padding: 20 } }}
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          marginBottom: 16,
        }}
      >
        <div className="f1g-auto-grid">
          <ServiceCard
            title="Store"
            state={data?.status === "active" ? "ok" : data?.status ? "warn" : "neutral"}
            icon={<ShopOutlined />}
            description={data?.storeDomain || "Đang kiểm tra"}
            detail={`Trạng thái: ${statusLabel[data?.status] || data?.status || "chưa rõ"}`}
          />
          <ServiceCard
            title="Webhook"
            state={
              webhookFailed > 0
                ? "error"
                : webhookProcessed === 0
                  ? "neutral"
                  : "ok"
            }
            icon={<SafetyCertificateOutlined />}
            description={webhookStatusLabel[data?.webhookStatus] || "chưa đăng ký"}
            detail={
              webhookProcessed === 0 && webhookFailed === 0
                ? "Chưa nhận webhook nào"
                : webhookFailed > 0
                  ? `${webhookFailed} webhook lỗi`
                  : `${webhookProcessed} webhook đã xử lý`
            }
          />
          <ServiceCard
            title="Hoạt động gần nhất"
            state={data?.lastUpdated ? "ok" : "neutral"}
            icon={<HeartOutlined />}
            description="Webhook xử lý gần nhất hoặc lần cài đặt cuối"
            detail={formatTime(data?.lastUpdated)}
          />
        </div>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={12} lg={6}>
          <NumberCard
            icon={<ApiOutlined />}
            label="Sản phẩm"
            value={data?.counts?.products || 0}
          />
        </Col>
        <Col xs={12} lg={6}>
          <NumberCard
            icon={<CheckCircleOutlined />}
            label="Đánh giá"
            value={data?.counts?.reviews || 0}
          />
        </Col>
        <Col xs={12} lg={6}>
          <NumberCard
            icon={<SafetyCertificateOutlined />}
            label="Câu hỏi"
            value={data?.counts?.questions || 0}
          />
        </Col>
        <Col xs={12} lg={6}>
          <NumberCard
            icon={<HeartOutlined />}
            label="Câu hỏi đã trả lời"
            value={data?.counts?.answered || 0}
            suffix={`/ ${formatNumber(data?.counts?.questions || 0)}`}
          />
        </Col>
      </Row>

      {webhookResult?.status && (
        <Alert
          type={webhookResult.status === "registered" ? "success" : "warning"}
          showIcon
          style={{ marginTop: 16 }}
          message="Kết quả resync webhook"
          description={`Trạng thái: ${webhookResult.status}${webhookResult.error ? ` - ${webhookResult.error}` : ""}`}
        />
      )}

      <Card
        title="Webhook gần đây"
        style={{ marginTop: 16 }}
        loading={isLoading}
      >
        {webhookRows.length ? (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={webhookRows}
            columns={[
              {
                title: "Topic",
                dataIndex: "topic",
                render: (value, row) => (
                  <Tooltip title={row.lastError || row.id}>
                    <Text>{value}</Text>
                  </Tooltip>
                ),
              },
              {
                title: "Trạng thái",
                dataIndex: "status",
                render: (value) => (
                  <Tag color={statusColor[value] || "default"}>
                    {webhookRowStatus[value] || value}
                  </Tag>
                ),
              },
              {
                title: "Retry",
                dataIndex: "attempts",
                align: "right",
                width: 70,
              },
              {
                title: "Cập nhật",
                dataIndex: "processedAt",
                render: formatTime,
              },
            ]}
            scroll={{ x: 620 }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Chưa nhận webhook nào từ Sapo"
          >
            <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
              Nếu store vừa cài app, hãy đăng ký lại webhook trong Công cụ vận hành ở trên.
            </Text>
          </Empty>
        )}
      </Card>
    </AdminLayout>
  );
};

export default OpsPage;
