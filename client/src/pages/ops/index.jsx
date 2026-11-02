import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Flex,
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
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import AdminLayout from "../../components/layout/AdminLayout";
import {
  fetchOpsHealth,
  resyncOpsConfig,
  resyncOpsWebhooks,
  backfillOpsCatalog,
} from "../../common/ApiService";
import { toast } from "../../common/toast";
import { getErrorMessage } from "../../common/getErrorMessage";
import { getStoreDomain } from "../../common/AuthStorage";
import { shopQueryKeys } from "../../common/queryKeys";

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
  });
};

const formatNumber = (value) => Number(value || 0).toLocaleString("vi-VN");

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

const ServiceCard = ({ title, ok, icon, description, detail }) => {
  const { token } = theme.useToken();
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
              background: ok ? token.colorSuccessBg : token.colorErrorBg,
              color: ok ? token.colorSuccessText : token.colorErrorText,
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
        <Badge status={ok ? "success" : "error"} text={ok ? "OK" : "Lỗi"} />
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
    unknown: "Không xác định",
  };

  return (
    <AdminLayout>
      <Flex
        justify="space-between"
        align="center"
        gap={16}
        wrap="wrap"
        style={{ marginBottom: 16 }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Vận hành
          </Title>
          <Text type="secondary">
            Trạng thái app trên store và các thao tác vận hành Sapo.
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
          <Button
            icon={<SettingOutlined />}
            loading={resyncConfig.isPending}
            onClick={() => resyncConfig.mutate()}
          >
            Resync config
          </Button>
          <Button
            icon={<SafetyCertificateOutlined />}
            loading={resyncWebhooks.isPending}
            onClick={() => resyncWebhooks.mutate()}
          >
            Resync webhooks
          </Button>
          <Button
            icon={<BuildOutlined />}
            loading={backfillCatalog.isPending}
            onClick={() => backfillCatalog.mutate()}
          >
            Backfill catalog
          </Button>
        </Space>
      </Flex>

      <Card
        loading={isLoading}
        styles={{ body: { padding: 20 } }}
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          marginBottom: 16,
        }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <ServiceCard
              title="Store"
              ok={Boolean(data?.storeDomain)}
              icon={<ShopOutlined />}
              description={data?.storeDomain || "Đang kiểm tra"}
              detail={`Status: ${statusLabel[data?.status] || data?.status || "unknown"}`}
            />
          </Col>
          <Col xs={24} md={8}>
            <ServiceCard
              title="Webhook"
              ok={webhookFailed === 0}
              icon={<SafetyCertificateOutlined />}
              description={data?.webhookStatus || "not_configured"}
              detail={
                webhookFailed > 0
                  ? `${webhookFailed} webhook lỗi`
                  : `${webhookProcessed} webhook đã xử lý`
              }
            />
          </Col>
          <Col xs={24} md={8}>
            <ServiceCard
              title="Cập nhật"
              ok={Boolean(data?.lastUpdated)}
              icon={<HeartOutlined />}
              description="Lần kiểm tra gần nhất"
              detail={formatTime(data?.lastUpdated)}
            />
          </Col>
        </Row>
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
                  <Tag color={statusColor[value] || "default"}>{value}</Tag>
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
            description="Chưa có webhook"
          />
        )}
      </Card>
    </AdminLayout>
  );
};

export default OpsPage;
