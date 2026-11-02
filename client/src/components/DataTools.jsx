import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Dropdown,
  Flex,
  Input,
  Modal,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import { DownloadOutlined, InboxOutlined } from "@ant-design/icons";
import { toast } from "../common/toast";
import { getErrorMessage } from "../common/getErrorMessage";

const { Text } = Typography;

export const downloadExport = (payload, fallbackName) => {
  if (!payload?.body) {
    toast.error("Máy chủ không trả về dữ liệu xuất");
    return;
  }
  const blob = new Blob([payload.body], {
    type: payload.contentType || "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const ExportMenu = ({ label, onExport, loading }) => (
  <Dropdown
    trigger={["click"]}
    menu={{
      items: [
        { key: "csv", label: "Xuất CSV (Excel)" },
        { key: "json", label: "Xuất JSON (sao lưu)" },
      ],
      onClick: ({ key }) => onExport(key),
    }}
  >
    <Button icon={<DownloadOutlined />} loading={loading}>
      {label}
    </Button>
  </Dropdown>
);

const readFileAsText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Không đọc được tệp"));
    reader.readAsText(file);
  });

const formatFromName = (name) => (/\.json$/i.test(name) ? "json" : "csv");

const ResultSummary = ({ result, verb }) => {
  if (!result) return null;
  return (
    <Flex vertical gap={8}>
      <Space size={6} wrap>
        <Tag color="success">Tạo mới: {result.created}</Tag>
        <Tag color="processing">Cập nhật: {result.updated}</Tag>
        <Tag>Bỏ qua: {result.skipped}</Tag>
        <Tag color={result.failed ? "error" : "default"}>Lỗi: {result.failed}</Tag>
        <Tag color="blue">Tổng dòng: {result.total}</Tag>
      </Space>
      {result.summarySync ? (
        <Text type="secondary">
          Đồng bộ điểm đánh giá: {result.summarySync.synced} sản phẩm
          {result.summarySync.queued ? `, ${result.summarySync.queued} xếp hàng` : ""}
        </Text>
      ) : null}
      {result.errors?.length ? (
        <Table
          size="small"
          rowKey={(row) => `${row.row}-${row.reviewId || row.questionId || ""}-${row.message}`}
          pagination={{ pageSize: 5, size: "small" }}
          dataSource={result.errors}
          columns={[
            { title: "Dòng", dataIndex: "row", width: 70 },
            {
              title: "Mã",
              dataIndex: "reviewId",
              width: 120,
              render: (value, row) => value || row.questionId || "-",
            },
            { title: "Lý do", dataIndex: "message" },
          ]}
        />
      ) : null}
      {result.runId ? (
        <Text type="secondary">{verb} xong, mã lần chạy {result.runId}.</Text>
      ) : null}
    </Flex>
  );
};

export const ImportModal = ({
  open,
  onClose,
  importFn,
  subjectLabel,
  onImported,
}) => {
  const [format, setFormat] = useState("csv");
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState("");
  const [dryResult, setDryResult] = useState(null);
  const [appliedResult, setAppliedResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) {
      setBody("");
      setFileName("");
      setDryResult(null);
      setAppliedResult(null);
      setFormat("csv");
    }
  }, [open]);

  const canSubmit = body.trim().length >= 2;

  const runDry = async () => {
    setChecking(true);
    setAppliedResult(null);
    try {
      const result = await importFn({ format, body, dryRun: true });
      setDryResult(result);
      if (!result?.errors?.length && !result?.failed) {
        toast.success("Dữ liệu hợp lệ, có thể nhập");
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Không kiểm tra được tệp"));
    } finally {
      setChecking(false);
    }
  };

  const runApply = async () => {
    setApplying(true);
    try {
      const result = await importFn({ format, body, dryRun: false });
      setAppliedResult(result);
      setDryResult(null);
      toast.success(`Đã nhập ${result.created} mục mới, cập nhật ${result.updated} mục`);
      onImported?.();
    } catch (error) {
      toast.error(getErrorMessage(error, "Nhập dữ liệu thất bại"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Nhập ${subjectLabel} từ CSV/JSON`}
      width={760}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>Đóng</Button>,
        <Button key="check" loading={checking} disabled={!canSubmit} onClick={runDry}>
          Kiểm tra dữ liệu
        </Button>,
        <Button
          key="apply"
          type="primary"
          loading={applying}
          disabled={!canSubmit || !dryResult || dryResult.failed > 0}
          onClick={runApply}
        >
          Nhập {dryResult ? `${dryResult.created + dryResult.updated} mục` : "vào hệ thống"}
        </Button>,
      ]}
    >
      <Alert
        type="info"
        showIcon
        message="Kiểm tra trước khi nhập"
        description={`Bước 1 kiểm tra định dạng và sản phẩm; bước 2 mới ghi vào hệ thống. Tối đa 1000 dòng mỗi lần.`}
        style={{ marginBottom: 12 }}
      />
      <Flex gap={8} align="center" wrap style={{ marginBottom: 12 }}>
        <Radio.Group
          value={format}
          onChange={(event) => {
            setFormat(event.target.value);
            setDryResult(null);
            setAppliedResult(null);
          }}
          optionType="button"
          options={[
            { label: "CSV", value: "csv" },
            { label: "JSON", value: "json" },
          ]}
        />
        <Upload
          accept=".csv,.json,text/csv,application/json"
          showUploadList={false}
          beforeUpload={async (file) => {
            try {
              const text = await readFileAsText(file);
              setBody(text);
              setFileName(file.name);
              setFormat(formatFromName(file.name));
              setDryResult(null);
              setAppliedResult(null);
            } catch (error) {
              toast.error(getErrorMessage(error, "Không đọc được tệp"));
            }
            return false;
          }}
        >
          <Button icon={<InboxOutlined />}>Chọn tệp…</Button>
        </Upload>
        {fileName ? <Text type="secondary">{fileName}</Text> : null}
      </Flex>
      <Input.TextArea
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          setDryResult(null);
          setAppliedResult(null);
        }}
        rows={8}
        placeholder={format === "json" ? '[{"product_id":"100","rating":5,…}]' : "product_id,review_id,rating,author,content,…"}
      />
      <Divider style={{ margin: "12px 0" }} />
      <ResultSummary result={dryResult} verb="Đã kiểm tra" />
      <ResultSummary result={appliedResult} verb="Đã nhập" />
    </Modal>
  );
};

export const BulkActionBar = ({ count, onClear, actions, busy }) => {
  if (!count) return null;
  return (
    <Flex
      align="center"
      gap={8}
      wrap
      className="f1g-bulk-bar"
      role="region"
      aria-label="Thao tác hàng loạt"
    >
      <Text strong>Đã chọn {count} mục</Text>
      {actions.map((action) => (
        <Button
          key={action.key}
          size="small"
          danger={action.danger}
          disabled={busy}
          onClick={action.onClick}
          icon={action.icon}
        >
          {action.label}
        </Button>
      ))}
      <Button size="small" type="text" onClick={onClear} disabled={busy}>
        Bỏ chọn
      </Button>
    </Flex>
  );
};
