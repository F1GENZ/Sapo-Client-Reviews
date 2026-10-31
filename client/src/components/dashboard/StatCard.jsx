import { Card, Flex, Typography } from "antd";
import { ArrowRightOutlined } from "@ant-design/icons";
import Link from "../StoreLink";

const { Text } = Typography;

const StatCard = ({ icon, iconBg, label, value, suffix, extra, to }) => (
  <Card
    hoverable
    style={{ borderRadius: 12, border: "none", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}
    styles={{ body: { padding: "20px 24px" } }}
  >
    <Flex align="center" gap={16}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          color: "#fff",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 2 }}>
          {label}
        </Text>
        <Flex align="baseline" gap={6}>
          <span style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>{value}</span>
          {suffix && <Text type="secondary" style={{ fontSize: 13 }}>{suffix}</Text>}
        </Flex>
        {extra}
      </div>
      {to && (
        <Link to={to}>
          <ArrowRightOutlined style={{ color: "#bbb", fontSize: 16 }} />
        </Link>
      )}
    </Flex>
  </Card>
);

export default StatCard;
