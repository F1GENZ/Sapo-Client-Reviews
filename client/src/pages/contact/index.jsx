import Link from "../../components/StoreLink";
import AdminLayout from "../../components/layout/AdminLayout";
import {
  Alert,
  Breadcrumb,
  Card,
  Divider,
  Flex,
  Tag,
  Typography,
} from "antd";
import {
  ClockCircleOutlined,
  CustomerServiceOutlined,
  GlobalOutlined,
  HomeOutlined,
  MailOutlined,
  MessageOutlined,
  PhoneOutlined,
} from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;

const contacts = [
  {
    icon: <MailOutlined style={{ color: "#1677ff", fontSize: 18 }} />,
    label: "Email hỗ trợ",
    value: "support@f1genz.com",
    href: "mailto:support@f1genz.com",
    tag: { color: "blue", text: "Ưu tiên" },
  },
  {
    icon: <MessageOutlined style={{ color: "#722ed1", fontSize: 18 }} />,
    label: "Zalo OA",
    value: "F1GENZ Support",
    href: "https://zalo.me/f1genz",
  },
  {
    icon: <GlobalOutlined style={{ color: "#13c2c2", fontSize: 18 }} />,
    label: "Website",
    value: "f1genz.com",
    href: "https://f1genz.com",
  },
  {
    icon: <PhoneOutlined style={{ color: "#52c41a", fontSize: 18 }} />,
    label: "Hotline",
    value: "Liên hệ qua email/Zalo",
  },
];

const ContactItem = ({ icon, label, value, href, tag }) => (
  <Flex align="center" gap={14} style={{ padding: "12px 0" }}>
    <div
      style={{
        alignItems: "center",
        background: "#f6f8fa",
        borderRadius: 10,
        display: "flex",
        flexShrink: 0,
        height: 40,
        justifyContent: "center",
        width: 40,
      }}
    >
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <Text type="secondary" style={{ display: "block", fontSize: 12, lineHeight: 1.2 }}>
        {label}
      </Text>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "block", fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
        >
          {value}
        </a>
      ) : (
        <Text strong style={{ display: "block", fontSize: 14, lineHeight: 1.5 }}>
          {value}
        </Text>
      )}
    </div>
    {tag ? <Tag color={tag.color} style={{ fontSize: 12 }}>{tag.text}</Tag> : null}
  </Flex>
);

const ContactPage = () => (
  <AdminLayout>
    <Breadcrumb
      items={[
        { title: <Link to="/"><HomeOutlined /></Link> },
        { title: "Liên hệ" },
      ]}
      style={{ marginBottom: 16 }}
    />

    <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap" style={{ marginBottom: 18 }}>
      <div>
        <Title level={4} style={{ margin: 0 }}>Liên hệ hỗ trợ</Title>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Kênh hỗ trợ cho chủ shop và đội kỹ thuật khi cần xử lý theme/storefront.
        </Text>
      </div>
      <Link to="/dev">
        <Tag color="blue" style={{ padding: "4px 10px", margin: 0 }}>Hướng dẫn kỹ thuật</Tag>
      </Link>
    </Flex>

    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 16 }}
      message="Ưu tiên gửi kèm ngữ cảnh"
      description="Khi báo lỗi, gửi thêm tên miền cửa hàng (tên miền cửa hàng, dạng ten-cua-hang.mysapo.net), link sản phẩm, ảnh màn hình và bước tái hiện để xử lý nhanh hơn."
    />

    <div
      className="f1g-contact-grid"
      style={{
        alignItems: "start",
        display: "grid",
        gap: 16,
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
      }}
    >
      <Card size="small" style={{ borderRadius: 12 }} styles={{ body: { padding: "8px 20px" } }}>
        <Flex align="center" gap={8} style={{ paddingTop: 8, marginBottom: 2 }}>
          <CustomerServiceOutlined style={{ color: "#1677ff", fontSize: 16 }} />
          <Text strong>Thông tin liên hệ</Text>
        </Flex>
        {contacts.map((contact, index) => (
          <div key={contact.label}>
            <ContactItem {...contact} />
            {index < contacts.length - 1 ? <Divider style={{ margin: 0 }} /> : null}
          </div>
        ))}
      </Card>

      <Card size="small" style={{ borderRadius: 12 }} styles={{ body: { padding: "16px 20px" } }}>
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <ClockCircleOutlined style={{ color: "#faad14", fontSize: 16 }} />
          <Text strong>Giờ hỗ trợ</Text>
        </Flex>
        <Flex vertical gap={10}>
          <Flex align="center" gap={8}>
            <Tag color="green" style={{ margin: 0, padding: "2px 10px" }}>T2 - T6</Tag>
            <Text>9:00 - 18:00 GMT+7</Text>
          </Flex>
          <Flex align="center" gap={8}>
            <Tag color="orange" style={{ margin: 0, padding: "2px 10px" }}>T7</Tag>
            <Text>9:00 - 12:00 GMT+7</Text>
          </Flex>
          <Flex align="center" gap={8}>
            <Tag color="default" style={{ margin: 0, padding: "2px 10px" }}>CN</Tag>
            <Text>Nghỉ</Text>
          </Flex>
        </Flex>
        <Paragraph type="secondary" style={{ fontSize: 12, lineHeight: 1.7, margin: "14px 0 0" }}>
          Ngoài giờ làm việc, vui lòng gửi email. Các lỗi ảnh hưởng storefront đang chạy sẽ được ưu tiên xử lý trước.
        </Paragraph>
      </Card>
    </div>
  </AdminLayout>
);

export default ContactPage;
