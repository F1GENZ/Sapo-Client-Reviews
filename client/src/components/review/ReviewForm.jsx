import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, DatePicker, Flex, Form, Input, Progress, Row, Col, Select, Switch, Typography } from "antd";
import { DeleteOutlined, LinkOutlined, LoadingOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchWidgetConfig } from "../../common/ApiService";
import { getStoreDomain } from "../../common/AuthStorage";
import { getErrorMessage } from "../../common/getErrorMessage";
import { shopQueryKeys } from "../../common/queryKeys";
import { toast } from "../../common/toast";
import { useMediaUpload } from "../../hooks/useMediaUpload";
import { useCreateReview } from "../../hooks/useCreateReview";
import { StarPicker } from "./StarRating";
import { normalizeVideoLink } from "../../common/mediaUrl";

const { Text } = Typography;
const MAX_MEDIA = 5;
const EMAIL_RE = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const PHONE_RE = /^(0[2-9]\d{8}|(\+?84)[2-9]\d{8})$/;
const DEFAULT_WIDGET_CONFIG = {
  formEmailMode: "optional",
  formPhoneMode: "optional",
  formTitleMode: "optional",
  formContentMode: "optional",
  allowImage: true,
  allowVideo: true,
};
const FORM_MODES = ["hidden", "optional", "required"];

const normalizeFormMode = (value, fallback, legacyRequired) => {
  if (FORM_MODES.includes(value)) return value;
  if (legacyRequired === true) return "required";
  if (legacyRequired === false && fallback === "required") return "optional";
  return fallback;
};

const normalizeWidgetConfig = (config = {}) => {
  const next = { ...DEFAULT_WIDGET_CONFIG, ...config };
  next.formTitleMode = normalizeFormMode(config.formTitleMode, DEFAULT_WIDGET_CONFIG.formTitleMode);
  next.formContentMode = normalizeFormMode(config.formContentMode, DEFAULT_WIDGET_CONFIG.formContentMode, config.formContentRequired);
  next.formEmailMode = normalizeFormMode(config.formEmailMode, DEFAULT_WIDGET_CONFIG.formEmailMode);
  next.formPhoneMode = normalizeFormMode(config.formPhoneMode, DEFAULT_WIDGET_CONFIG.formPhoneMode);
  delete next.formContentRequired;
  return next;
};

const buildTextRules = ({ label, mode = "optional", max, type }) => {
  if (mode === "hidden") return [];

  return [
    {
      validator: async (_, value) => {
        const text = typeof value === "string" ? value.trim() : "";

        if (mode === "required" && !text) {
          throw new Error(`${label} là bắt buộc`);
        }
        if (!text) return;

        if (max && text.length > max) {
          throw new Error(`${label} tối đa ${max} ký tự`);
        }
        if (type === "email" && !EMAIL_RE.test(text)) {
          throw new Error("Email không hợp lệ");
        }
        if (type === "phone" && !PHONE_RE.test(text.replace(/[\s\-().]/g, ""))) {
          throw new Error("Số điện thoại không hợp lệ");
        }
      },
    },
  ];
};

const getFieldPlaceholder = (label, mode) => (
  mode === "required" ? `${label} *` : `${label} (không bắt buộc)`
);

const ReviewForm = ({ products = [], initialProductId = null, onSuccess }) => {
  const [form] = Form.useForm();
  const [mediaItems, setMediaItems] = useState([]);
  const [videoUrl, setVideoUrl] = useState("");
  const fileRef = useRef(null);
  const storeDomain = getStoreDomain();
  const { upload, uploading, progress } = useMediaUpload();
  const createMutation = useCreateReview();
  const isFormBusy = uploading || createMutation.isPending;
  const selectedProductId = Form.useWatch("productId", form);
  const ratingValue = Form.useWatch("rating", form) || 0;

  const { data: widgetConfigData } = useQuery({
    queryKey: shopQueryKeys.widgetConfig(storeDomain),
    queryFn: fetchWidgetConfig,
    enabled: !!storeDomain,
    staleTime: 5 * 60 * 1000,
  });

  const widgetConfig = useMemo(
    () => normalizeWidgetConfig(widgetConfigData),
    [widgetConfigData],
  );

  const allowImage = widgetConfig.allowImage !== false;
  const allowVideo = widgetConfig.allowVideo !== false;
  const acceptedTypes = [
    ...(allowImage ? ["image/jpeg", "image/png", "image/webp"] : []),
    ...(allowVideo ? ["video/mp4"] : []),
  ];
  const canUploadMedia = acceptedTypes.length > 0;

  const productOptions = products.map((product) => ({
    value: String(product.id),
    label: product.title,
  }));

  const titleMode = widgetConfig.formTitleMode || "optional";
  const contentMode = widgetConfig.formContentMode || "optional";
  const emailMode = widgetConfig.formEmailMode || "optional";
  const phoneMode = widgetConfig.formPhoneMode || "optional";

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);

    if (!selectedProductId) {
      toast.warning("Chọn sản phẩm trước khi upload media");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    if (!canUploadMedia) {
      toast.warning("Media đang bị tắt trong cấu hình");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    if (mediaItems.length + files.length > MAX_MEDIA) {
      toast.warning(`Tối đa ${MAX_MEDIA} file media`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    for (const file of files) {
      if (!acceptedTypes.includes(file.type)) {
        toast.error(`File ${file.name}: loại file không hỗ trợ`);
        continue;
      }

      try {
        const result = await upload(file, selectedProductId);
        setMediaItems((prev) => [...prev, result]);
      } catch (error) {
        toast.error(getErrorMessage(error, `Upload ${file.name} thất bại`));
      }
    }

    if (fileRef.current) fileRef.current.value = "";
  };

  const removeMedia = (index) => {
    setMediaItems((prev) => prev.filter((_, i) => i !== index));
  };

  const addVideoLink = () => {
    const url = normalizeVideoLink(videoUrl);
    if (!url) {
      toast.warning("Link video phải là URL HTTPS hợp lệ");
      return;
    }
    if (mediaItems.length >= MAX_MEDIA) {
      toast.warning(`Tối đa ${MAX_MEDIA} media`);
      return;
    }
    if (mediaItems.some((item) => item.url === url)) {
      toast.warning("Link video đã tồn tại");
      return;
    }
    setMediaItems((prev) => [...prev, { url, type: "video" }]);
    setVideoUrl("");
  };

  const handleSubmit = async (values) => {
    const title = (values.title || "").trim();
    const content = (values.content || "").trim();
    const email = (values.email || "").trim();
    const phone = (values.phone || "").trim();

    try {
      await createMutation.mutateAsync({
        productId: values.productId,
        data: {
          rating: values.rating,
          author: values.author.trim(),
          status: values.status || "approved",
          verified: values.verified || false,
          pinned: values.pinned || false,
          ...(values.reviewDate ? { created_at: values.reviewDate.valueOf() } : {}),
          ...(titleMode !== "hidden" && title ? { title } : {}),
          ...(contentMode !== "hidden" && content ? { content } : {}),
          ...(emailMode !== "hidden" && email ? { email } : {}),
          ...(phoneMode !== "hidden" && phone ? { phone } : {}),
          media: mediaItems,
        },
      });

      toast.success("Đã thêm đánh giá");
      form.resetFields();
      setMediaItems([]);
      setVideoUrl("");
      onSuccess?.(values.productId);
    } catch (err) {
      toast.error(getErrorMessage(err, "Thêm đánh giá thất bại"));
    }
  };

  return (
    <Form
      form={form}
      onFinish={handleSubmit}
      layout="vertical"
      initialValues={{
        productId: initialProductId || undefined,
        status: "approved",
        verified: false,
        pinned: false,
      }}
      requiredMark={false}
    >
      <Flex vertical gap={12}>
        <Form.Item
          name="productId"
          rules={[{ required: true, message: "Vui lòng chọn sản phẩm" }]}
          style={{ marginBottom: 0 }}
        >
          <Select
            showSearch
            size="large"
            disabled={isFormBusy}
            placeholder="Click để chọn sản phẩm"
            options={productOptions}
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          name="rating"
          rules={[{ required: true, message: "Vui lòng chọn số sao" }]}
          style={{ marginBottom: 0 }}
        >
          <Flex align="center" gap={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>Đánh giá:</Text>
            <StarPicker value={ratingValue} onChange={(value) => form.setFieldsValue({ rating: value })} />
          </Flex>
        </Form.Item>

        <Row gutter={8}>
          <Col span={8}>
            <Form.Item
              name="author"
              rules={[
                { required: true, message: "Vui lòng nhập tên" },
                {
                  validator: async (_, value) => {
                    const text = typeof value === "string" ? value.trim() : "";
                    if (!text) return;
                    if (text.length < 2) throw new Error("Tên phải có ít nhất 2 ký tự");
                    if (text.length > 100) throw new Error("Tên tối đa 100 ký tự");
                  },
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <Input placeholder="Tên người đánh giá *" maxLength={100} />
            </Form.Item>
          </Col>

          {emailMode !== "hidden" && (
            <Col span={phoneMode !== "hidden" ? 8 : 16}>
              <Form.Item
                name="email"
                rules={buildTextRules({ label: "Email", mode: emailMode, max: 200, type: "email" })}
                style={{ marginBottom: 0 }}
              >
                <Input placeholder={getFieldPlaceholder("Email", emailMode)} maxLength={200} type="email" />
              </Form.Item>
            </Col>
          )}

          {phoneMode !== "hidden" && (
            <Col span={emailMode !== "hidden" ? 8 : 16}>
              <Form.Item
                name="phone"
                rules={buildTextRules({ label: "Số điện thoại", mode: phoneMode, type: "phone" })}
                style={{ marginBottom: 0 }}
              >
                <Input placeholder={getFieldPlaceholder("Số điện thoại", phoneMode)} maxLength={20} />
              </Form.Item>
            </Col>
          )}
        </Row>

        {titleMode !== "hidden" && (
          <Form.Item
            name="title"
            rules={buildTextRules({ label: "Tiêu đề", mode: titleMode, max: 100 })}
            style={{ marginBottom: 0 }}
          >
            <Input placeholder={getFieldPlaceholder("Tiêu đề đánh giá", titleMode)} maxLength={100} />
          </Form.Item>
        )}

        {contentMode !== "hidden" && (
          <Form.Item
            name="content"
            rules={buildTextRules({ label: "Nội dung", mode: contentMode, max: 2000 })}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              placeholder={getFieldPlaceholder("Nội dung đánh giá", contentMode)}
              maxLength={2000}
              rows={8}
              style={{ minHeight: 220 }}
              showCount
            />
          </Form.Item>
        )}

        <Row gutter={8}>
          <Col span={12}>
            <Flex vertical gap={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>Trạng thái</Text>
              <Form.Item name="status" style={{ marginBottom: 0 }}>
                <Select
                  size="small"
                  style={{ width: "100%" }}
                  options={[
                    { label: "Đã duyệt", value: "approved" },
                    { label: "Chờ duyệt", value: "pending" },
                    { label: "Đã ẩn", value: "hidden" },
                  ]}
                />
              </Form.Item>
            </Flex>
          </Col>
          <Col span={12}>
            <Flex vertical gap={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>Ngày đánh giá</Text>
              <Form.Item name="reviewDate" style={{ marginBottom: 0 }}>
                <DatePicker
                  size="small"
                  style={{ width: "100%" }}
                  placeholder="Mặc định: hôm nay"
                  disabledDate={(d) => d && d.isAfter(dayjs())}
                  format="DD/MM/YYYY"
                />
              </Form.Item>
            </Flex>
          </Col>
        </Row>

        <Flex gap={24}>
          <Flex align="center" gap={8}>
            <Form.Item name="verified" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch aria-label="Mua hàng đã xác minh" size="small" />
            </Form.Item>
            <Text style={{ fontSize: 13 }}>Mua hàng đã xác minh</Text>
          </Flex>
          <Flex align="center" gap={8}>
            <Form.Item name="pinned" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch aria-label="Ghim đánh giá lên đầu" size="small" />
            </Form.Item>
            <Text style={{ fontSize: 13 }}>Ghim lên đầu</Text>
          </Flex>
        </Flex>

        {canUploadMedia && (
          <div>
            <Flex wrap="wrap" gap={8}>
              {mediaItems.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    position: "relative",
                    width: 64,
                    height: 64,
                    borderRadius: 8,
                    overflow: "hidden",
                    border: "1px solid #d9d9d9",
                  }}
                >
                  {item.type === "video" ? (
                    <Flex align="center" justify="center" style={{ width: "100%", height: "100%", background: "#fafafa" }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>Video</Text>
                    </Flex>
                  ) : (
                    <img src={item.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}

                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined style={{ fontSize: 10 }} />}
                    onClick={() => removeMedia(idx)}
                    disabled={isFormBusy}
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -2,
                      width: 20,
                      height: 20,
                      minWidth: 20,
                      borderRadius: "50%",
                      background: "#ff4d4f",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  />
                </div>
              ))}

              {mediaItems.length < MAX_MEDIA && (
                <button
                  type="button"
                  onClick={() => {
                    if (!isFormBusy && selectedProductId) fileRef.current?.click();
                  }}
                  disabled={isFormBusy || !selectedProductId}
                  aria-label="Thêm media"
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 8,
                    border: "1px dashed #d9d9d9",
                    cursor: isFormBusy || !selectedProductId ? "not-allowed" : "pointer",
                    opacity: isFormBusy || !selectedProductId ? 0.5 : 1,
                    color: "#999",
                    fontSize: 18,
                    background: "transparent",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {uploading ? <LoadingOutlined /> : <PlusOutlined />}
                </button>
              )}
            </Flex>

            {uploading && (
              <Progress percent={progress} size="small" style={{ marginTop: 8 }} />
            )}

            <input
              ref={fileRef}
              type="file"
              accept={acceptedTypes.join(",")}
              multiple
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />

            {allowVideo && mediaItems.length < MAX_MEDIA && (
              <Flex gap={8} style={{ marginTop: 10 }}>
                <Input
                  value={videoUrl}
                  onChange={(event) => setVideoUrl(event.target.value)}
                  onPressEnter={addVideoLink}
                  disabled={isFormBusy}
                  placeholder="Dán link video HTTPS, YouTube hoặc Vimeo"
                  maxLength={2000}
                />
                <Button
                  icon={<LinkOutlined />}
                  onClick={addVideoLink}
                  disabled={isFormBusy || !videoUrl.trim()}
                >
                  Thêm link
                </Button>
              </Flex>
            )}
          </div>
        )}

        <Flex justify="end">
          <Button
            type="primary"
            htmlType="submit"
            loading={createMutation.isPending}
            disabled={isFormBusy}
          >
            Gửi đánh giá
          </Button>
        </Flex>
      </Flex>
    </Form>
  );
};

export default ReviewForm;
