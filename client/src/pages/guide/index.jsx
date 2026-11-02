import Link from "../../components/StoreLink";
import AdminLayout from "../../components/layout/AdminLayout";
import {
  Alert,
  Breadcrumb,
  Card,
  Collapse,
  Flex,
  Steps,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  HomeOutlined,
  ImportOutlined,
  QuestionCircleOutlined,
  RocketOutlined,
  SettingOutlined,
  StarOutlined,
  SyncOutlined,
} from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;

const faqItems = [
  {
    key: "reviews-not-showing",
    label: "Đánh giá chưa hiện ngoài storefront?",
    children: (
      <Paragraph type="secondary" style={{ margin: 0, lineHeight: 1.7 }}>
        Kiểm tra đánh giá đã ở trạng thái <Text strong>Đã duyệt</Text>, sản phẩm có đúng
        <Text code> productId</Text>, và storefront đã được gắn code theo mục <Link to="/dev">Dev guide</Link>.
      </Paragraph>
    ),
  },
  {
    key: "qna",
    label: "Hỏi đáp khác gì đánh giá?",
    children: (
      <Paragraph type="secondary" style={{ margin: 0, lineHeight: 1.7 }}>
        Hỏi đáp dùng để khách đặt câu hỏi trước khi mua. Câu hỏi có thể chờ duyệt, đã trả lời hoặc đã ẩn.
        Đánh giá dùng cho rating, media, phản hồi shop và schema rating.
      </Paragraph>
    ),
  },
  {
    key: "import",
    label: "Import dữ liệu nên dùng lúc nào?",
    children: (
      <Paragraph type="secondary" style={{ margin: 0, lineHeight: 1.7 }}>
        Dùng khi shop cần chuyển dữ liệu từ hệ thống khác sang app. Vào màn <Text strong>Đánh giá</Text> hoặc
        <Text strong> Hỏi đáp</Text>, bấm <Text strong>Nhập CSV/JSON</Text> để chọn tệp hoặc dán nội dung. Mỗi lần
        nhập tối đa 1000 dòng; luôn bấm <Text strong>Kiểm tra dữ liệu</Text> trước khi ghi thật.
      </Paragraph>
    ),
  },
  {
    key: "settings",
    label: "Cấu hình giao diện có ảnh hưởng dữ liệu không?",
    children: (
      <Paragraph type="secondary" style={{ margin: 0, lineHeight: 1.7 }}>
        Không. Cấu hình chỉ điều chỉnh cách hiển thị form, màu sắc, số item và các trạng thái ngoài storefront.
        Dữ liệu đánh giá và hỏi đáp vẫn lưu riêng trong DB của app.
      </Paragraph>
    ),
  },
  {
    key: "purchase-gate",
    label: "Bật chỉ khách đã mua mới được đánh giá thì cần gì?",
    children: (
      <Paragraph type="secondary" style={{ margin: 0, lineHeight: 1.7 }}>
        Theme cần truyền <Text code>customer-email</Text> hoặc <Text code>customer-phone</Text> vào widget theo
        <Link to="/dev"> Dev guide</Link>. Khách chưa đăng nhập sẽ thấy CTA đăng nhập; khách đã đăng nhập nhưng chưa có đơn paid/fulfilled sẽ không mở form.
      </Paragraph>
    ),
  },
];

const GuidePage = () => (
  <AdminLayout>
    <Breadcrumb
      items={[
        { title: <Link to="/"><HomeOutlined /></Link> },
        { title: "Hướng dẫn" },
      ]}
      style={{ marginBottom: 16 }}
    />

    <Flex
      align="flex-start"
      justify="space-between"
      gap={16}
      wrap="wrap"
      style={{ marginBottom: 18 }}
    >
      <div>
        <Title level={4} style={{ margin: 0 }}>Hướng dẫn sử dụng</Title>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Quy trình vận hành app Review cho chủ shop và đội CSKH.
        </Text>
      </div>
      <Flex gap={8} wrap="wrap">
        <Link to="/dev">
          <Tag color="blue" style={{ padding: "4px 10px", margin: 0 }}>Hướng dẫn kỹ thuật</Tag>
        </Link>
        <Link to="/contact">
          <Tag color="blue" style={{ padding: "4px 10px", margin: 0 }}>Liên hệ hỗ trợ</Tag>
        </Link>
      </Flex>
    </Flex>

    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 16 }}
      message="Trang này dành cho vận hành"
      description="Phần gắn code vào theme đã tách riêng sang Dev guide để tránh nhầm giữa thao tác quản trị và thao tác kỹ thuật."
    />

    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 0.8fr)",
        gap: 16,
        alignItems: "start",
      }}
      className="f1g-guide-grid"
    >
      <Card size="small" style={{ borderRadius: 12 }} styles={{ body: { padding: "20px 24px" } }}>
        <Flex align="center" gap={8} style={{ marginBottom: 18 }}>
          <RocketOutlined style={{ color: "#1677ff", fontSize: 17 }} />
          <Text strong style={{ fontSize: 15 }}>Luồng dùng nhanh</Text>
        </Flex>
        <Steps
          direction="vertical"
          current={0}
          status="process"
          items={[
            {
              title: "Kiểm tra tổng quan",
              description: "Xem tổng số đánh giá, hỏi đáp và các đánh giá gần đây ngay tại màn Tổng quan.",
              icon: <CheckCircleOutlined />,
            },
            {
              title: "Cấu hình storefront",
              description: "Vào Cấu hình để chỉnh hiển thị, form bắt buộc, chỉ khách đã mua mới đánh giá, hỏi đáp, duyệt spam và giao diện.",
              icon: <SettingOutlined />,
            },
            {
              title: "Quản lý đánh giá",
              description: "Duyệt, ẩn, đánh dấu spam, phản hồi shop hoặc tạo đánh giá mới theo từng sản phẩm.",
              icon: <StarOutlined />,
            },
            {
              title: "Quản lý hỏi đáp",
              description: "Duyệt câu hỏi, trả lời khách, ẩn nội dung không phù hợp và theo dõi câu chưa trả lời.",
              icon: <QuestionCircleOutlined />,
            },
            {
              title: "Import dữ liệu khi cần",
              description: "Dùng Nhập CSV/JSON ở màn Đánh giá hoặc Hỏi đáp để nhập một lần nhiều dòng. Luôn kiểm tra trước khi ghi thật.",
              icon: <ImportOutlined />,
            },
            {
              title: "Đồng bộ storefront",
              description: "Khi dữ liệu đã đúng, sync sản phẩm/storefront và kiểm tra Health để đảm bảo worker, webhook, queue không còn lỗi.",
              icon: <SyncOutlined />,
            },
          ]}
        />
      </Card>

      <Card size="small" style={{ borderRadius: 12 }} styles={{ body: { padding: "18px 20px" } }}>
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 16 }} />
          <Text strong>Checklist trước khi bàn giao</Text>
        </Flex>
        <Flex vertical gap={10}>
          <Text type="secondary">1. Storefront đã gắn code theo <Link to="/dev">Dev guide</Link>.</Text>
          <Text type="secondary">2. Form bắt buộc đúng với cấu hình đang bật.</Text>
          <Text type="secondary">3. Nếu bật chỉ khách đã mua mới đánh giá, theme đã truyền email/phone khách hàng.</Text>
          <Text type="secondary">4. Review test hiển thị đúng ở trang sản phẩm và product card.</Text>
          <Text type="secondary">5. Hỏi đáp test hiển thị đúng trạng thái đã trả lời/chờ trả lời.</Text>
          <Text type="secondary">6. JSON-LD không lỗi trong Rich Results Test.</Text>
        </Flex>
      </Card>
    </div>

    <Card
      size="small"
      style={{ borderRadius: 12, marginTop: 16 }}
      styles={{ body: { padding: "16px 20px" } }}
    >
      <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
        <QuestionCircleOutlined style={{ color: "#722ed1", fontSize: 16 }} />
        <Text strong>Câu hỏi thường gặp</Text>
      </Flex>
      <Collapse ghost items={faqItems} expandIconPosition="end" />
    </Card>

    <style>
      {`
        @media (max-width: 960px) {
          .f1g-guide-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}
    </style>
  </AdminLayout>
);

export default GuidePage;
