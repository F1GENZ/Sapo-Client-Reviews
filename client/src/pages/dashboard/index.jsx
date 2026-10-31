import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDashboardOverview } from "../../common/ApiService";
import { getStoreDomain } from "../../common/AuthStorage";
import { shopQueryKeys } from "../../common/queryKeys";
import AdminLayout from "../../components/layout/AdminLayout";
import { useStoreRoute } from "../../hooks/useStoreRoute";
import {
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Progress,
  Rate,
  Row,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import Link from "../../components/StoreLink";
import {
  ArrowRightOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CommentOutlined,
  FireFilled,
  HomeOutlined,
  MessageOutlined,
  PictureOutlined,
  QuestionCircleFilled,
  SafetyCertificateFilled,
  StarFilled,
  TrophyFilled,
  WarningFilled,
} from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;

const numberFormatter = new Intl.NumberFormat("vi-VN");

const formatNumber = (value) => numberFormatter.format(Number(value || 0));

const formatPercent = (value) => `${Math.round(Number(value || 0))}%`;

const timeAgo = (ts) => {
  const time = Number(ts || 0);
  if (!time) return "";
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60000) return "Vừa xong";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return `${Math.floor(days / 30)} tháng trước`;
};

const cardStyle = {
  borderRadius: 8,
  border: "1px solid rgba(5, 5, 5, 0.06)",
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
};

const getInitial = (name) => String(name || "?").trim().charAt(0).toUpperCase();

const isGenericProductLabel = (value, productId) =>
  Boolean(productId && String(value || "").trim() === `Sản phẩm #${productId}`);

const resolveProductLabel = (title, name, productId) =>
  [title, name].find((value) => value && !isGenericProductLabel(value, productId)) ||
  "Không rõ sản phẩm";

const getReviewStatusTag = (status) => {
  if (status === "pending") return <Tag color="gold">Chờ duyệt</Tag>;
  if (status === "hidden") return <Tag>Đã ẩn</Tag>;
  if (status === "spam") return <Tag color="red">Spam</Tag>;
  return <Tag color="green">Đã duyệt</Tag>;
};

const VN_DATE_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const buildTrend = (trend = []) => {
  const counts = new Map(trend.map((item) => [item.date, Number(item.count || 0)]));
  const days = [];
  const now = Date.now();
  for (let index = 13; index >= 0; index -= 1) {
    const key = VN_DATE_KEY.format(new Date(now - index * 86400000));
    const [, month, day] = key.split("-");
    days.push({ date: key, label: `${day}/${month}`, count: counts.get(key) || 0 });
  }
  return days;
};

const KpiCard = ({ icon, label, value, hint, tone, to }) => {
  const content = (
    <Card hoverable={Boolean(to)} style={{ ...cardStyle, height: "100%" }} styles={{ body: { padding: 18 } }}>
      <Flex justify="space-between" gap={12} align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
            {label}
          </Text>
          <div style={{ fontSize: 28, fontWeight: 760, lineHeight: 1.1, letterSpacing: 0 }}>
            {value}
          </div>
          {hint ? (
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              {hint}
            </Text>
          ) : null}
        </div>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: tone.bg,
            color: tone.fg,
            fontSize: 20,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
      </Flex>
    </Card>
  );
  return to ? (
    <Link to={to} style={{ display: "block", height: "100%" }}>
      {content}
    </Link>
  ) : (
    content
  );
};

const RatingDistribution = ({ distribution, total }) => {
  const rows = [5, 4, 3, 2, 1].map((star) => {
    const count = Number(distribution?.[star] || 0);
    return {
      star,
      count,
      percent: total ? Math.round((count / total) * 100) : 0,
    };
  });

  return (
    <Card title="Chất lượng đánh giá" style={{ ...cardStyle, height: "100%" }} styles={{ body: { paddingTop: 8 } }}>
      <div style={{ display: "grid", gap: 10 }}>
        {rows.map((row) => (
          <div
            key={row.star}
            style={{
              display: "grid",
              gridTemplateColumns: "46px 1fr 58px",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Text style={{ fontSize: 12 }}>
              {row.star} <StarFilled style={{ color: "#f59e0b" }} />
            </Text>
            <Progress
              percent={row.percent}
              showInfo={false}
              strokeColor={row.star >= 4 ? "#16a34a" : row.star === 3 ? "#f59e0b" : "#ef4444"}
              trailColor="#eef2f7"
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 12, textAlign: "right" }}>
              {formatNumber(row.count)}
            </Text>
          </div>
        ))}
      </div>
    </Card>
  );
};

const TrendCard = ({ trend }) => {
  const rows = buildTrend(trend);
  const max = Math.max(1, ...rows.map((item) => item.count));
  const total = rows.reduce((sum, item) => sum + item.count, 0);

  return (
    <Card title="Xu hướng 14 ngày" style={{ ...cardStyle, height: "100%" }} styles={{ body: { paddingTop: 8 } }}>
      <Flex align="end" gap={6} style={{ minHeight: 132 }}>
        {rows.map((item) => (
          <Tooltip key={item.date} title={`${item.label}: ${formatNumber(item.count)} đánh giá`}>
            <div style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
              <div
                style={{
                  height: 104,
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    maxWidth: 18,
                    height: `${Math.max(6, (item.count / max) * 100)}%`,
                    borderRadius: "5px 5px 2px 2px",
                    background: item.count ? "#2563eb" : "#e5e7eb",
                  }}
                />
              </div>
            </div>
          </Tooltip>
        ))}
      </Flex>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {formatNumber(total)} đánh giá mới trong 14 ngày gần nhất
      </Text>
    </Card>
  );
};

const TaskRow = ({ icon, label, count, tone, to }) => (
  <Flex
    align="center"
    justify="space-between"
    gap={12}
    style={{
      padding: "12px 0",
      borderBottom: "1px solid #f0f2f5",
      minHeight: 58,
    }}
  >
    <Flex align="center" gap={10} style={{ minWidth: 0 }}>
      <div
        style={{
          width: 34,
          height: 34,
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
      <div style={{ minWidth: 0 }}>
        <Text strong style={{ display: "block", fontSize: 13 }}>
          {label}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatNumber(count)} mục
        </Text>
      </div>
    </Flex>
    <Link to={to} className="f1g-icon-link-button" aria-label={`Mở ${label}`}>
      <ArrowRightOutlined aria-hidden="true" />
    </Link>
  </Flex>
);

const ProductImage = ({ src, title }) =>
  src ? (
    <img
      src={src}
      alt={title || ""}
      loading="lazy"
      style={{
        width: 42,
        height: 42,
        borderRadius: 8,
        objectFit: "cover",
        background: "#f3f4f6",
        flexShrink: 0,
      }}
    />
  ) : (
    <Avatar shape="square" size={42} style={{ borderRadius: 8, background: "#e0f2fe", color: "#0369a1" }}>
      {getInitial(title)}
    </Avatar>
  );

const ProductRow = ({ product, index, buildRoute }) => (
  <Link to={buildRoute(`/reviews?product=${product.id || product.productId}`)} style={{ display: "block" }}>
    <Flex
      align="center"
      gap={12}
      style={{
        padding: "11px 0",
        borderBottom: "1px solid #f0f2f5",
        minHeight: 64,
      }}
    >
      <Text strong style={{ width: 22, color: "#64748b", textAlign: "center" }}>
        {index + 1}
      </Text>
      <ProductImage src={product.image?.src || product.image} title={product.title} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong ellipsis style={{ display: "block", fontSize: 13 }}>
          {product.title}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatNumber(product.count || product.reviewCount)} đánh giá
        </Text>
      </div>
      <Flex align="center" gap={4} style={{ flexShrink: 0 }}>
        <StarFilled style={{ color: "#f59e0b", fontSize: 13 }} />
        <Text strong style={{ fontSize: 13 }}>
          {Number(product.avg || product.reviewAvg || 0).toFixed(1)}
        </Text>
      </Flex>
    </Flex>
  </Link>
);

const AttentionProductRow = ({ product, buildRoute }) => {
  const label =
    product.reason === "mixed"
      ? "Điểm thấp và còn câu hỏi"
      : product.reason === "low_rating"
        ? "Điểm cần cải thiện"
        : "Còn câu hỏi chưa trả lời";
  const productRoute =
    product.reason === "unanswered_qna" ||
    (product.reason === "mixed" && Number(product.qnaUnanswered || 0) > 0)
      ? `/qna?product=${product.productId}`
      : `/reviews?product=${product.productId}`;

  return (
    <Link to={buildRoute(productRoute)} style={{ display: "block" }}>
      <Flex align="center" gap={12} style={{ padding: "11px 0", borderBottom: "1px solid #f0f2f5" }}>
        <ProductImage src={product.image} title={product.title} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong ellipsis style={{ display: "block", fontSize: 13 }}>
            {product.title}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {label}
          </Text>
        </div>
        <Tag color={product.reason === "unanswered_qna" ? "blue" : "orange"} style={{ margin: 0 }}>
          {product.reason === "unanswered_qna"
            ? `${formatNumber(product.qnaUnanswered)} Q&A`
            : Number(product.reviewAvg || 0).toFixed(1)}
        </Tag>
      </Flex>
    </Link>
  );
};

const RecentReviewRow = ({ review, buildRoute }) => (
  <div style={{ padding: "13px 0", borderBottom: "1px solid #f0f2f5" }}>
    <Flex align="flex-start" gap={12}>
      <Avatar size={34} style={{ background: "#0f766e", flexShrink: 0 }}>
        {getInitial(review.author)}
      </Avatar>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap={8} wrap="wrap" style={{ marginBottom: 4 }}>
          <Text strong style={{ fontSize: 13 }}>
            {review.author || "Khách hàng"}
          </Text>
          <Rate disabled value={Number(review.rating || 0)} style={{ fontSize: 12 }} />
          {getReviewStatusTag(review.status)}
          {review.verified ? <Tag color="green" icon={<CheckCircleFilled />}>Đã mua</Tag> : null}
        </Flex>
        <Paragraph
          ellipsis={{ rows: 2 }}
          style={{ display: "block", fontSize: 13, lineHeight: 1.45, marginBottom: 0 }}
        >
          {review.content || "Không có nội dung"}
        </Paragraph>
        <Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 5 }}>
          {review.productId ? (
            <Link to={buildRoute(`/reviews?product=${review.productId}`)}>
              {resolveProductLabel(review.productTitle, review.productName, review.productId)}
            </Link>
          ) : (
            resolveProductLabel(review.productTitle, review.productName, review.productId)
          )}
          {review.created_at ? ` · ${timeAgo(review.created_at)}` : ""}
        </Text>
      </div>
      {review.media?.[0]?.url ? (
        <img
          src={review.media[0].url}
          alt=""
          loading="lazy"
          style={{
            width: 52,
            height: 52,
            borderRadius: 8,
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : null}
    </Flex>
  </div>
);

const RecentQuestionRow = ({ question, buildRoute }) => (
  <div style={{ padding: "13px 0", borderBottom: "1px solid #f0f2f5" }}>
    <Flex align="flex-start" gap={12}>
      <Avatar size={34} style={{ background: question.answered ? "#16a34a" : "#d97706", flexShrink: 0 }}>
        <QuestionCircleFilled />
      </Avatar>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap={8} wrap="wrap" style={{ marginBottom: 4 }}>
          <Text strong style={{ fontSize: 13 }}>
            {question.author || "Khách hàng"}
          </Text>
          <Tag color={question.answered ? "green" : "gold"}>
            {question.answered ? "Đã trả lời" : "Chưa trả lời"}
          </Tag>
        </Flex>
        <Paragraph
          ellipsis={{ rows: 2 }}
          style={{ display: "block", fontSize: 13, lineHeight: 1.45, marginBottom: 0 }}
        >
          {question.question}
        </Paragraph>
        <Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 5 }}>
          <Link to={buildRoute(`/qna?product=${question.productId}`)}>
            {resolveProductLabel(question.productTitle, question.productName, question.productId)}
          </Link>
          {question.created_at ? ` · ${timeAgo(question.created_at)}` : ""}
        </Text>
      </div>
    </Flex>
  </div>
);

const DashboardPage = () => {
  const { token } = theme.useToken();
  const storeDomain = getStoreDomain();
  const buildRoute = useStoreRoute();
  const { data, isLoading } = useQuery({
    queryKey: shopQueryKeys.dashboardOverview(storeDomain),
    queryFn: fetchDashboardOverview,
    staleTime: 2 * 60 * 1000,
    enabled: !!storeDomain,
  });

  const overview = data || {};
  const pendingWork =
    Number(overview.statusCounts?.pending || 0) +
    Number(overview.statusCounts?.unreplied || 0) +
    Number(overview.qnaStatusCounts?.unanswered || overview.totalUnanswered || 0);
  const fiveStarPercent = overview.totalReviews
    ? Math.round(((overview.globalDist?.[5] || 0) / overview.totalReviews) * 100)
    : 0;
  const verifiedPercent = overview.totalReviews
    ? Math.round(((overview.verifiedCount || 0) / overview.totalReviews) * 100)
    : 0;

  const heroNote = useMemo(() => {
    if (!overview.totalReviews && !overview.totalQuestions) {
      return "Shop chưa có dữ liệu đánh giá hoặc hỏi đáp.";
    }
    if (pendingWork > 0) return `${formatNumber(pendingWork)} mục cần xử lý`;
    return "Mọi mục quan trọng đã được xử lý";
  }, [overview.totalReviews, overview.totalQuestions, pendingWork]);

  return (
    <AdminLayout>
      <div style={{ width: "100%" }}>
        <Breadcrumb
          items={[
            { title: <Link to={buildRoute("/")}><HomeOutlined /></Link> },
            { title: "Tổng quan" },
          ]}
          style={{ marginBottom: 14 }}
        />

        <Flex justify="space-between" align="flex-start" gap={16} wrap="wrap" style={{ marginBottom: 18 }}>
          <div>
            <Title level={3} style={{ margin: 0, lineHeight: 1.2 }}>
              Tổng quan
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {heroNote}
            </Text>
          </div>
          <Flex align="center" gap={8} wrap="wrap">
            <Tag color={pendingWork ? "gold" : "green"} style={{ margin: 0, padding: "4px 10px", borderRadius: 6 }}>
              {pendingWork ? "Cần xử lý" : "Ổn định"}
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Cập nhật {overview.lastUpdated ? timeAgo(overview.lastUpdated) : "vừa xong"}
            </Text>
          </Flex>
        </Flex>

        {!isLoading && Array.isArray(overview.degraded) && overview.degraded.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="Một số số liệu chưa tải được"
            description={`Các phần sau gặp lỗi khi tải và có thể hiển thị thiếu: ${overview.degraded.join(", ")}. Hãy tải lại trang sau ít phút.`}
          />
        ) : null}

        {isLoading ? (
          <div style={{ textAlign: "center", padding: "88px 0" }}>
            <Spin size="large" />
          </div>
        ) : !overview.totalReviews && !overview.totalQuestions ? (
          <Card style={cardStyle} styles={{ body: { padding: 36, textAlign: "center" } }}>
            <Empty
              description="Chưa có dữ liệu để hiển thị"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
            <Flex justify="center" gap={10} wrap="wrap">
              <Link to={buildRoute("/reviews")}>
                <Button type="primary" icon={<StarFilled />}>Quản lý đánh giá</Button>
              </Link>
              <Link to={buildRoute("/qna")}>
                <Button icon={<QuestionCircleFilled />}>Quản lý hỏi đáp</Button>
              </Link>
            </Flex>
          </Card>
        ) : (
          <>
            <Row gutter={[14, 14]}>
              <Col xs={24} sm={12} xl={6}>
                <KpiCard
                  icon={<StarFilled />}
                  label="Tổng đánh giá"
                  value={formatNumber(overview.totalReviews)}
                  hint={`${formatPercent(fiveStarPercent)} là đánh giá 5 sao`}
                  tone={{ bg: "#fff7ed", fg: "#c2410c" }}
                  to={buildRoute("/reviews")}
                />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <KpiCard
                  icon={<TrophyFilled />}
                  label="Điểm trung bình"
                  value={Number(overview.globalAvg || 0).toFixed(1)}
                  hint={`${formatNumber(overview.productCount)} sản phẩm có tương tác`}
                  tone={{ bg: "#ecfdf5", fg: "#047857" }}
                  to={buildRoute("/reviews")}
                />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <KpiCard
                  icon={<MessageOutlined />}
                  label="Chưa phản hồi"
                  value={formatNumber(overview.statusCounts?.unreplied)}
                  hint={`${formatNumber(overview.statusCounts?.pending)} đánh giá chờ duyệt`}
                  tone={{ bg: "#eff6ff", fg: "#1d4ed8" }}
                  to={buildRoute("/reviews")}
                />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <KpiCard
                  icon={<QuestionCircleFilled />}
                  label="Q&A chưa trả lời"
                  value={formatNumber(overview.qnaStatusCounts?.unanswered || overview.totalUnanswered)}
                  hint={`Tỉ lệ phản hồi ${formatPercent(overview.responseRate)}`}
                  tone={{ bg: "#fefce8", fg: "#a16207" }}
                  to={buildRoute("/qna")}
                />
              </Col>
            </Row>

            <Row gutter={[14, 14]} style={{ marginTop: 14 }}>
              <Col xs={24} lg={8}>
                <RatingDistribution distribution={overview.globalDist} total={overview.totalReviews} />
              </Col>
              <Col xs={24} lg={8}>
                <TrendCard trend={overview.reviewTrend} />
              </Col>
              <Col xs={24} lg={8}>
                <Card title="Việc cần xử lý" style={{ ...cardStyle, height: "100%" }} styles={{ body: { paddingTop: 4 } }}>
                  <TaskRow
                    icon={<ClockCircleOutlined />}
                    label="Đánh giá chờ duyệt"
                    count={overview.statusCounts?.pending}
                    tone={{ bg: "#fef3c7", fg: "#b45309" }}
                    to={buildRoute("/reviews")}
                  />
                  <TaskRow
                    icon={<CommentOutlined />}
                    label="Đánh giá chưa phản hồi"
                    count={overview.statusCounts?.unreplied}
                    tone={{ bg: "#dbeafe", fg: "#1d4ed8" }}
                    to={buildRoute("/reviews")}
                  />
                  <TaskRow
                    icon={<QuestionCircleFilled />}
                    label="Câu hỏi chưa trả lời"
                    count={overview.qnaStatusCounts?.unanswered || overview.totalUnanswered}
                    tone={{ bg: "#fee2e2", fg: "#b91c1c" }}
                    to={buildRoute("/qna")}
                  />
                  <Flex align="center" gap={8} style={{ paddingTop: 12 }}>
                    <Badge color={token.colorSuccess} />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatPercent(verifiedPercent)} đánh giá có huy hiệu đã mua
                    </Text>
                  </Flex>
                </Card>
              </Col>
            </Row>

            <Row gutter={[14, 14]} style={{ marginTop: 14 }}>
              <Col xs={24} lg={8}>
                <Card
                  title={<><TrophyFilled style={{ color: "#f59e0b", marginRight: 6 }} />Sản phẩm nổi bật</>}
                  extra={<Link to={buildRoute("/reviews")}>Xem tất cả</Link>}
                  style={{ ...cardStyle, height: "100%" }}
                  styles={{ body: { paddingTop: 4 } }}
                >
                  {(overview.rankedProducts || []).length ? (
                    overview.rankedProducts.map((product, index) => (
                      <ProductRow key={product.id} product={product} index={index} buildRoute={buildRoute} />
                    ))
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có sản phẩm nổi bật" />
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={8}>
                <Card
                  title={<><WarningFilled style={{ color: "#f97316", marginRight: 6 }} />Sản phẩm cần chú ý</>}
                  style={{ ...cardStyle, height: "100%" }}
                  styles={{ body: { paddingTop: 4 } }}
                >
                  {(overview.attentionProducts || []).length ? (
                    overview.attentionProducts.map((product) => (
                      <AttentionProductRow key={product.productId} product={product} buildRoute={buildRoute} />
                    ))
                  ) : (
                    <Flex align="center" gap={10} style={{ padding: "18px 0" }}>
                      <CheckCircleFilled style={{ color: "#16a34a", fontSize: 22 }} />
                      <Text>Không có sản phẩm cần ưu tiên xử lý.</Text>
                    </Flex>
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={8}>
                <Card title="Tín hiệu chất lượng" style={{ ...cardStyle, height: "100%" }}>
                  <Row gutter={[12, 12]}>
                    <Col span={12}>
                      <Flex vertical gap={6}>
                        <SafetyCertificateFilled style={{ color: "#16a34a", fontSize: 20 }} />
                        <Text strong>{formatNumber(overview.verifiedCount)}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>Đã mua hàng</Text>
                      </Flex>
                    </Col>
                    <Col span={12}>
                      <Flex vertical gap={6}>
                        <PictureOutlined style={{ color: "#2563eb", fontSize: 20 }} />
                        <Text strong>{formatNumber(overview.withMediaCount)}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>Có hình/video</Text>
                      </Flex>
                    </Col>
                    <Col span={12}>
                      <Flex vertical gap={6}>
                        <BarChartOutlined style={{ color: "#7c3aed", fontSize: 20 }} />
                        <Text strong>{formatPercent(fiveStarPercent)}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>Tỉ lệ 5 sao</Text>
                      </Flex>
                    </Col>
                    <Col span={12}>
                      <Flex vertical gap={6}>
                        <FireFilled style={{ color: "#ea580c", fontSize: 20 }} />
                        <Text strong>{formatNumber(overview.statusCounts?.approved)}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>Đã duyệt</Text>
                      </Flex>
                    </Col>
                  </Row>
                </Card>
              </Col>
            </Row>

            <Row gutter={[14, 14]} style={{ marginTop: 14 }}>
              <Col xs={24} xl={14}>
                <Card
                  title="Đánh giá gần đây"
                  extra={<Link to={buildRoute("/reviews")}>Xem tất cả <ArrowRightOutlined /></Link>}
                  style={cardStyle}
                  styles={{ body: { paddingTop: 0 } }}
                >
                  {(overview.recentReviews || []).length ? (
                    overview.recentReviews.slice(0, 8).map((review) => (
                      <RecentReviewRow key={review.id} review={review} buildRoute={buildRoute} />
                    ))
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có đánh giá mới" />
                  )}
                </Card>
              </Col>
              <Col xs={24} xl={10}>
                <Card
                  title="Hỏi đáp gần đây"
                  extra={<Link to={buildRoute("/qna")}>Xem tất cả <ArrowRightOutlined /></Link>}
                  style={cardStyle}
                  styles={{ body: { paddingTop: 0 } }}
                >
                  {(overview.recentQuestions || []).length ? (
                    overview.recentQuestions.slice(0, 8).map((question) => (
                      <RecentQuestionRow key={question.id} question={question} buildRoute={buildRoute} />
                    ))
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có câu hỏi mới" />
                  )}
                </Card>
              </Col>
            </Row>
          </>
        )}
      </div>
    </AdminLayout>
  );
};

export default DashboardPage;
