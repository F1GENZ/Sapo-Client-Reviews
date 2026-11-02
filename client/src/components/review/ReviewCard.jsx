import React, {
  useState, useReducer, useCallback, useEffect, useRef,
} from "react";
import dayjs from "dayjs";
import {
  DeleteOutlined,
  SendOutlined,
  RobotOutlined,
  EditOutlined,
  PlusOutlined,
  LinkOutlined,
  LoadingOutlined,
  CheckOutlined,
  EyeInvisibleOutlined,
  ShoppingOutlined,
} from "@ant-design/icons";
import { suggestReviewReply } from "../../common/ApiService";
import {
  Popconfirm,
  Card,
  Typography,
  Flex,
  Button,
  Input,
  Select,
  Switch,
  DatePicker,
  Modal,
  Tooltip,
  Row,
  Col,
  Tag,
} from "antd";
import { StarRating, StarPicker } from "./StarRating";
import ReviewMedia from "./ReviewMedia";
import { useMediaUpload } from "../../hooks/useMediaUpload";
import { getErrorMessage } from "../../common/getErrorMessage";
import { toast } from "../../common/toast";
import { normalizeVideoLink } from "../../common/mediaUrl";

const { Text, Paragraph } = Typography;

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4"];
const EMAIL_RE = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const MAX_MEDIA = 5;

const initEditState = {
  open: false,
  saving: false,
  rating: 0,
  author: "",
  email: "",
  phone: "",
  title: "",
  content: "",
  status: "approved",
  verified: false,
  pinned: false,
  date: null,
  media: [],
};

const editReducer = (state, action) => {
  switch (action.type) {
    case "OPEN":
      return { ...action.payload, open: true, saving: false };
    case "SET":
      return { ...state, [action.field]: action.value };
    case "SAVING":
      return { ...state, saving: true };
    case "DONE":
      return { ...state, saving: false };
    case "CLOSE":
      return { ...state, open: false, saving: false };
    default:
      return state;
  }
};

const normalizeMedia = (review) => {
  if (Array.isArray(review.media) && review.media.length) return review.media;

  const items = [];
  if (Array.isArray(review.images)) {
    review.images.forEach((url) => items.push({ url, type: "image" }));
  }
  if (review.video) {
    items.push({ url: review.video, type: "video" });
  }
  return items;
};

const isGenericProductLabel = (value, productId) =>
  Boolean(productId && String(value || "").trim() === `Sản phẩm #${productId}`);

const ReviewCard = ({
  review,
  onDelete,
  onReply,
  onEdit,
  onStatusChange,
  compact,
  productId,
  productUrl,
  surface = "card",
}) => {
  const [detailOpen, setDetailOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState(review.reply || "");
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [statusAction, setStatusAction] = useState(null);
  const [editVideoUrl, setEditVideoUrl] = useState("");
  const fileRef = useRef(null);
  const { upload, uploading, progress } = useMediaUpload();
  const [edit, dispatchEdit] = useReducer(editReducer, initEditState);

  useEffect(() => {
    setReplyText(review.reply || "");
  }, [review.reply]);

  const status = review.status || "approved";

  const openEdit = useCallback(() => {
    setEditVideoUrl("");
    dispatchEdit({
      type: "OPEN",
      payload: {
        rating: review.rating,
        author: review.author || "",
        email: review.email || "",
        phone: review.phone || "",
        title: review.title || "",
        content: review.content || "",
        status,
        verified: review.verified || false,
        pinned: review.pinned || false,
        date: review.created_at ? dayjs(review.created_at) : null,
        media: normalizeMedia(review),
      },
    });
  }, [review, status]);

  const handleEditFileSelect = useCallback(async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    if (!productId) {
      toast.error("Thiếu productId để upload media");
      return;
    }

    if ((edit.media?.length || 0) + files.length > MAX_MEDIA) {
      toast.warning(`Tối đa ${MAX_MEDIA} file media`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    let nextMedia = [...(edit.media || [])];

    for (const file of files) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(`File ${file.name}: loại file không hỗ trợ`);
        continue;
      }

      try {
        const result = await upload(file, productId);
        nextMedia = [...nextMedia, result];
      } catch (error) {
        toast.error(getErrorMessage(error, `Upload ${file.name} thất bại`));
      }
    }

    dispatchEdit({ type: "SET", field: "media", value: nextMedia });
    if (fileRef.current) fileRef.current.value = "";
  }, [edit.media, productId, upload]);

  const removeEditMedia = useCallback((index) => {
    dispatchEdit({
      type: "SET",
      field: "media",
      value: (edit.media || []).filter((_, itemIndex) => itemIndex !== index),
    });
  }, [edit.media]);

  const addEditVideoLink = useCallback(() => {
    const url = normalizeVideoLink(editVideoUrl);
    if (!url) {
      toast.warning("Link video phải là URL HTTPS hợp lệ");
      return;
    }
    if ((edit.media?.length || 0) >= MAX_MEDIA) {
      toast.warning(`Tối đa ${MAX_MEDIA} media`);
      return;
    }
    if ((edit.media || []).some((item) => item.url === url)) {
      toast.warning("Link video đã tồn tại");
      return;
    }
    dispatchEdit({
      type: "SET",
      field: "media",
      value: [...(edit.media || []), { url, type: "video" }],
    });
    setEditVideoUrl("");
  }, [edit.media, editVideoUrl]);

  const handleSaveEdit = async () => {
    const author = edit.author.trim();
    const email = edit.email.trim();
    const phone = edit.phone.trim();
    const title = edit.title.trim();
    const content = edit.content.trim();

    if (!author) {
      toast.warning("Vui lòng nhập tên");
      return;
    }

    if (email && !EMAIL_RE.test(email)) {
      toast.warning("Email không hợp lệ");
      return;
    }

    if (!edit.rating) {
      toast.warning("Vui lòng chọn số sao");
      return;
    }

    dispatchEdit({ type: "SAVING" });

    try {
      await onEdit(review.id, {
        rating: edit.rating,
        author,
        email,
        phone,
        title: title || undefined,
        content,
        status: edit.status,
        verified: edit.verified,
        pinned: edit.pinned,
        media: edit.media || [],
        ...(edit.date ? { created_at: edit.date.valueOf() } : {}),
      }, review);

      toast.success("Đã lưu thay đổi");
      dispatchEdit({ type: "CLOSE" });
    } catch (error) {
      toast.error(getErrorMessage(error, "Lưu đánh giá thất bại"));
      dispatchEdit({ type: "DONE" });
    }
  };

  const handleSuggestReply = async () => {
    if (!review.content) return;
    setAiSuggesting(true);
    try {
      const result = await suggestReviewReply({
        content: String(review.content).slice(0, 2000),
        rating: Number(review.rating) || 5,
        author: review.author ? String(review.author).slice(0, 100) : undefined,
      });
      if (result?.suggestion) {
        setReplyText(result.suggestion);
        toast.success("Đã tạo gợi ý, bạn có thể sửa trước khi gửi");
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Chưa tạo được gợi ý AI"));
    } finally {
      setAiSuggesting(false);
    }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !onReply) return;

    setReplySubmitting(true);
    try {
      await onReply(review.id, { reply: replyText.trim() }, review);
      setReplying(false);
      toast.success(review.reply ? "Đã cập nhật phản hồi" : "Đã gửi phản hồi");
    } catch (error) {
      toast.error(getErrorMessage(error, "Gửi phản hồi thất bại"));
    } finally {
      setReplySubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    setDeletePending(true);
    try {
      await onDelete(review.id, review);
      toast.success("Đã xóa đánh giá");
    } catch (error) {
      toast.error(getErrorMessage(error, "Xóa đánh giá thất bại"));
    } finally {
      setDeletePending(false);
    }
  };

  const handleStatusAction = async (nextStatus) => {
    if (!onStatusChange) return;

    const actionKey = nextStatus === "hidden"
      ? "hide"
      : status === "hidden"
        ? "restore"
        : "approve";

    setStatusAction(actionKey);
    try {
      await onStatusChange(review.id, nextStatus, review);
      toast.success(
        nextStatus === "hidden"
          ? "Đã ẩn đánh giá"
          : status === "hidden"
            ? "Đã hiện lại đánh giá"
            : "Đã duyệt đánh giá",
      );
    } catch (error) {
      toast.error(getErrorMessage(error, "Cập nhật trạng thái thất bại"));
    } finally {
      setStatusAction(null);
    }
  };

  const isBusy = replySubmitting || deletePending || edit.saving || uploading || !!statusAction;

  const dateStr = new Date(review.created_at).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const reviewProductId = review.productId || productId;
  const productLabel =
    [review.productTitle, review.productName].find(
      (value) => value && !isGenericProductLabel(value, reviewProductId),
    ) || (reviewProductId ? "Không rõ sản phẩm" : "");
  const mediaItems = normalizeMedia(review);
  const hasDetail = Boolean(review.content || review.reply || mediaItems.length);

  return (
    <>
      <Card
        size="small"
        style={{
          borderRadius: surface === "row" ? 0 : 8,
          border: surface === "row" ? 0 : undefined,
          boxShadow: surface === "row" ? "none" : undefined,
          background: surface === "row" ? "transparent" : undefined,
          height: compact ? "100%" : undefined,
          display: compact ? "flex" : undefined,
          flexDirection: compact ? "column" : undefined,
          ...(status === "spam"
            ? { borderLeft: "3px solid #ff4d4f" }
            : status === "pending"
              ? { borderLeft: "3px solid #faad14" }
              : status === "hidden"
                ? { borderLeft: "3px solid #d9d9d9" }
                : {}),
        }}
        styles={{
          body: {
            ...(compact ? { flex: 1, display: "flex", flexDirection: "column" } : {}),
            ...(surface === "row" ? { padding: "14px 16px" } : {}),
          },
        }}
      >
        <Flex justify="space-between" align="start">
          <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Flex align="center" gap={8} wrap="wrap">
              <Text strong style={{ fontSize: 13, lineHeight: 1.4 }}>{review.author}</Text>
              <StarRating value={review.rating} size={12} />
            </Flex>
            <Flex align="center" gap={8} wrap="wrap">
              <Text type="secondary" style={{ fontSize: 11 }}>{dateStr}</Text>
              {review.email ? <Text type="secondary" style={{ fontSize: 11 }}>• {review.email}</Text> : null}
              {review.phone ? <Text type="secondary" style={{ fontSize: 11 }}>• {review.phone}</Text> : null}
            </Flex>
            {productLabel ? (
              <a
                href={productUrl || undefined}
                target={productUrl ? "_blank" : undefined}
                rel={productUrl ? "noopener noreferrer" : undefined}
                onClick={(event) => {
                  if (!productUrl) event.preventDefault();
                }}
                style={{ width: "fit-content", maxWidth: "100%" }}
              >
              <Tag
                icon={<ShoppingOutlined />}
                color="blue"
                style={{
                  marginTop: 6,
                  marginInlineEnd: 0,
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  width: "fit-content",
                }}
                title={productLabel}
              >
                {productLabel}
              </Tag>
              </a>
            ) : null}
          </Flex>

          <Flex gap={2}>
            {onEdit ? (
              <Tooltip title="Chỉnh sửa">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={openEdit}
                  aria-label="Chỉnh sửa"
                  disabled={isBusy}
                />
              </Tooltip>
            ) : null}

            {status === "pending" && onStatusChange ? (
              <Tooltip title="Duyệt">
                <Button
                  type="text"
                  size="small"
                  icon={<CheckOutlined />}
                  style={{ color: "#52c41a" }}
                  onClick={() => handleStatusAction("approved")}
                  aria-label="Duyệt"
                  loading={statusAction === "approve"}
                  disabled={deletePending || replySubmitting || edit.saving || uploading || statusAction === "hide" || statusAction === "restore"}
                />
              </Tooltip>
            ) : null}

            {status !== "hidden" && onStatusChange ? (
              <Tooltip title="Ẩn">
                <Button
                  type="text"
                  size="small"
                  icon={<EyeInvisibleOutlined />}
                  onClick={() => handleStatusAction("hidden")}
                  aria-label="Ẩn"
                  loading={statusAction === "hide"}
                  disabled={deletePending || replySubmitting || edit.saving || uploading || statusAction === "approve" || statusAction === "restore"}
                />
              </Tooltip>
            ) : null}

            {status === "hidden" && onStatusChange ? (
              <Tooltip title="Hiện lại">
                <Button
                  type="text"
                  size="small"
                  icon={<CheckOutlined />}
                  style={{ color: "#52c41a" }}
                  onClick={() => handleStatusAction("approved")}
                  aria-label="Hiện lại"
                  loading={statusAction === "restore"}
                  disabled={deletePending || replySubmitting || edit.saving || uploading || statusAction === "approve" || statusAction === "hide"}
                />
              </Tooltip>
            ) : null}

            {onDelete ? (
              <Popconfirm
                title="Xóa đánh giá này?"
                onConfirm={handleDelete}
                okText="Xóa"
                cancelText="Hủy"
                okButtonProps={{ loading: deletePending, danger: true }}
                cancelButtonProps={{ disabled: deletePending }}
              >
                <Button
                  type="text"
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  aria-label="Xóa"
                  loading={deletePending}
                  disabled={replySubmitting || edit.saving || !!statusAction}
                />
              </Popconfirm>
            ) : null}
          </Flex>
        </Flex>

        {review.title ? (
          <Text strong style={{ display: "block", marginTop: 6, fontSize: 13 }}>{review.title}</Text>
        ) : null}

        {review.content ? (
          <Paragraph
            style={{ marginTop: 6, marginBottom: 0, fontSize: 13, flex: compact ? 1 : undefined }}
            ellipsis={{ rows: compact ? 2 : 3 }}
          >
            {review.content}
          </Paragraph>
        ) : null}

        {(hasDetail || (!review.reply && !replying && onReply && !compact)) ? (
          <Flex align="center" gap={16} wrap="wrap" style={{ marginTop: 8 }}>
            {hasDetail ? (
              <Button
                type="link"
                size="small"
                onClick={() => setDetailOpen(true)}
                style={{ display: "flex", width: "fit-content", padding: 0 }}
              >
                Xem chi tiết
              </Button>
            ) : null}
            {!review.reply && !replying && onReply && !compact ? (
              <Button
                type="link"
                size="small"
                icon={<SendOutlined />}
                onClick={() => setReplying(true)}
                style={{ display: "flex", width: "fit-content", padding: 0 }}
                disabled={isBusy}
              >
                Phản hồi
              </Button>
            ) : null}
          </Flex>
        ) : null}

        {mediaItems.length > 0 && !compact && surface !== "row" ? (
          <div style={{ marginTop: 12 }}>
            <ReviewMedia items={mediaItems} />
          </div>
        ) : null}

        {review.reply && !replying && !compact && surface !== "row" ? (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              background: "#f0f5ff",
              borderLeft: "3px solid #1677ff",
              borderRadius: "0 6px 6px 0",
            }}
          >
            <Text style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#1677ff",
              textTransform: "uppercase",
            }}
            >
              Phản hồi từ Shop
            </Text>
            {review.replied_at ? (
              <Text type="secondary" style={{ fontSize: 10, marginLeft: 8 }}>
                {new Date(review.replied_at).toLocaleDateString("vi-VN")}
              </Text>
            ) : null}
            <Paragraph style={{ margin: "4px 0 0", fontSize: 13 }}>{review.reply}</Paragraph>
            {onReply ? (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setReplying(true);
                  setReplyText(review.reply);
                }}
                style={{ padding: 0, fontSize: 11 }}
                disabled={isBusy}
              >
                Chỉnh sửa
              </Button>
            ) : null}
          </div>
        ) : null}

        {replying && !compact ? (
          <div style={{ marginTop: 10 }}>
            <Input.TextArea
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
              placeholder="Nhập phản hồi…"
              rows={5}
              maxLength={2000}
              showCount
            />
            <Flex gap={8} style={{ marginTop: 8 }} wrap>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                loading={replySubmitting}
                onClick={handleReply}
                disabled={!replyText.trim() || isBusy}
              >
                Gửi phản hồi
              </Button>
              <Button
                size="small"
                icon={<RobotOutlined />}
                loading={aiSuggesting}
                disabled={isBusy || !review.content}
                title={!review.content ? "Đánh giá không có nội dung để gợi ý" : undefined}
                onClick={handleSuggestReply}
              >
                Gợi ý bằng AI
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setReplying(false);
                  setReplyText(review.reply || "");
                }}
                disabled={replySubmitting}
              >
                Hủy
              </Button>
            </Flex>
          </div>
        ) : null}
      </Card>

      {detailOpen ? (
      <Modal
        title="Chi tiết đánh giá"
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={[
          <Button key="close" onClick={() => setDetailOpen(false)}>
            Đóng
          </Button>,
          onEdit ? (
            <Button
              key="edit"
              type="primary"
              icon={<EditOutlined />}
              onClick={() => {
                setDetailOpen(false);
                openEdit();
              }}
            >
              Chỉnh sửa
            </Button>
          ) : null,
        ].filter(Boolean)}
        width={1040}
        styles={{ body: { maxHeight: "calc(100vh - 180px)", overflowY: "auto" } }}
        destroyOnHidden
      >
        <Flex vertical gap={14}>
          <Flex justify="space-between" align="start" gap={16} wrap>
            <Flex vertical gap={6} style={{ minWidth: 0 }}>
              <Flex align="center" gap={8} wrap>
                <Text strong>{review.author}</Text>
                <StarRating value={review.rating} size={14} />
              </Flex>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {dateStr}
                {review.email ? ` • ${review.email}` : ""}
                {review.phone ? ` • ${review.phone}` : ""}
              </Text>
              {productLabel ? (
                <Tag icon={<ShoppingOutlined />} color="blue" style={{ width: "fit-content", maxWidth: "100%" }}>
                  {productLabel}
                </Tag>
              ) : null}
            </Flex>
          </Flex>

          {review.title ? <Text strong>{review.title}</Text> : null}
          {review.content ? (
            <Paragraph style={{ marginBottom: 0, fontSize: 14, lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
              {review.content}
            </Paragraph>
          ) : null}

          {mediaItems.length ? <ReviewMedia items={mediaItems} /> : null}

          {review.reply ? (
            <div
              style={{
                padding: "12px 14px",
                background: "#f0f5ff",
                borderLeft: "3px solid #1677ff",
                borderRadius: "0 8px 8px 0",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: 700, color: "#1677ff", textTransform: "uppercase" }}>
                Phản hồi từ Shop
              </Text>
              <Paragraph style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                {review.reply}
              </Paragraph>
            </div>
          ) : null}
        </Flex>
      </Modal>
      ) : null}

      {onEdit && edit.open ? (
        <Modal
          title="Chỉnh sửa đánh giá"
          open={edit.open}
          onCancel={() => {
            if (!edit.saving) dispatchEdit({ type: "CLOSE" });
          }}
          onOk={handleSaveEdit}
          okText="Lưu thay đổi"
          cancelText="Hủy"
          confirmLoading={edit.saving}
          okButtonProps={{ disabled: edit.saving || !edit.rating || !edit.author.trim() }}
          cancelButtonProps={{ disabled: edit.saving }}
          width={1040}
          styles={{ body: { maxHeight: "calc(100vh - 180px)", overflowY: "auto" } }}
          destroyOnHidden
          closable={!edit.saving}
          maskClosable={!edit.saving}
        >
          <Flex vertical gap={12} style={{ paddingTop: 8 }}>
            <Flex align="center" gap={8}>
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap", minWidth: 70 }}>Số sao:</Text>
              <StarPicker
                value={edit.rating}
                onChange={(value) => dispatchEdit({ type: "SET", field: "rating", value })}
              />
            </Flex>

            <Row gutter={10}>
              <Col span={8}>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 11 }}>Tên *</Text>
                  <Input
                    value={edit.author}
                    onChange={(event) => dispatchEdit({ type: "SET", field: "author", value: event.target.value })}
                    placeholder="Tên người đánh giá"
                    maxLength={100}
                  />
                </Flex>
              </Col>
              <Col span={8}>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 11 }}>Email</Text>
                  <Input
                    value={edit.email}
                    onChange={(event) => dispatchEdit({ type: "SET", field: "email", value: event.target.value })}
                    placeholder="Email"
                    maxLength={200}
                    type="email"
                  />
                </Flex>
              </Col>
              <Col span={8}>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 11 }}>Số điện thoại</Text>
                  <Input
                    value={edit.phone}
                    onChange={(event) => dispatchEdit({ type: "SET", field: "phone", value: event.target.value })}
                    placeholder="Số điện thoại"
                    maxLength={20}
                  />
                </Flex>
              </Col>
            </Row>

            <Flex vertical gap={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>Tiêu đề</Text>
              <Input
                value={edit.title}
                onChange={(event) => dispatchEdit({ type: "SET", field: "title", value: event.target.value })}
                placeholder="Tiêu đề đánh giá"
                maxLength={100}
              />
            </Flex>

            <Flex vertical gap={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>Nội dung</Text>
              <Input.TextArea
                value={edit.content}
                onChange={(event) => dispatchEdit({ type: "SET", field: "content", value: event.target.value })}
                placeholder="Nội dung đánh giá"
                rows={10}
                style={{ minHeight: 260 }}
                maxLength={2000}
              />
              <Flex justify="flex-end">
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {edit.content?.length || 0} / 2000
                </Text>
              </Flex>
            </Flex>

            <Flex vertical gap={8}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                Media (
                {edit.media?.length || 0}
                /
                {MAX_MEDIA}
                )
              </Text>

              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4"
                multiple
                hidden
                onChange={handleEditFileSelect}
              />

              {(edit.media?.length || 0) < MAX_MEDIA ? (
                <Flex gap={8}>
                  <Input
                    value={editVideoUrl}
                    onChange={(event) => setEditVideoUrl(event.target.value)}
                    onPressEnter={addEditVideoLink}
                    disabled={uploading}
                    placeholder="Dán link video HTTPS, YouTube hoặc Vimeo"
                    maxLength={2000}
                  />
                  <Button
                    icon={<LinkOutlined />}
                    onClick={addEditVideoLink}
                    disabled={uploading || !editVideoUrl.trim()}
                  >
                    Thêm link
                  </Button>
                </Flex>
              ) : null}

              <Flex wrap="wrap" gap={8}>
                {edit.media?.map((item, index) => (
                  <div
                    key={`${item.url}-${index}`}
                    style={{
                      width: 88,
                      border: "1px solid #f0f0f0",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "#fafafa",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: 72,
                        background: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {item.type === "video" ? (
                        <video
                          src={item.url}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <img
                          src={item.url}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      )}
                    </div>
                    <Button
                      type="text"
                      danger
                      size="small"
                      block
                      onClick={() => removeEditMedia(index)}
                      disabled={uploading}
                      style={{ borderRadius: 0 }}
                    >
                      Xóa
                    </Button>
                  </div>
                ))}

                {(edit.media?.length || 0) < MAX_MEDIA ? (
                  <Button
                    type="dashed"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading || !productId}
                    style={{
                      width: 88,
                      height: 104,
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "column",
                      gap: 6,
                      color: "#595959",
                    }}
                  >
                    {uploading ? <LoadingOutlined /> : <PlusOutlined />}
                    <span style={{ fontSize: 12 }}>{uploading ? "Đang tải" : "Thêm media"}</span>
                  </Button>
                ) : null}
              </Flex>

              {!edit.media?.length ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Chưa có media cho đánh giá này.
                </Text>
              ) : null}

              {uploading ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Đang upload… {progress}%
                </Text>
              ) : null}
            </Flex>

            <Row gutter={10}>
              <Col span={12}>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 11 }}>Trạng thái</Text>
                  <Select
                    value={edit.status}
                    onChange={(value) => dispatchEdit({ type: "SET", field: "status", value })}
                    style={{ width: "100%" }}
                    options={[
                      { label: "Đã duyệt", value: "approved" },
                      { label: "Chờ duyệt", value: "pending" },
                      { label: "Đã ẩn", value: "hidden" },
                      { label: "Spam", value: "spam" },
                    ]}
                  />
                </Flex>
              </Col>
              <Col span={12}>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 11 }}>Ngày đánh giá</Text>
                  <DatePicker
                    value={edit.date}
                    onChange={(value) => dispatchEdit({ type: "SET", field: "date", value })}
                    style={{ width: "100%" }}
                    placeholder="Ngày đánh giá"
                    disabledDate={(date) => date && date.isAfter(dayjs())}
                    format="DD/MM/YYYY"
                  />
                </Flex>
              </Col>
            </Row>

            <Flex gap={32}>
              <Flex align="center" gap={8}>
                <Switch
                  aria-label="Mua hàng đã xác minh"
                  checked={edit.verified}
                  onChange={(value) => dispatchEdit({ type: "SET", field: "verified", value })}
                  size="small"
                />
                <Text style={{ fontSize: 13 }}>Mua hàng đã xác minh</Text>
              </Flex>
              <Flex align="center" gap={8}>
                <Switch
                  aria-label="Ghim đánh giá lên đầu"
                  checked={edit.pinned}
                  onChange={(value) => dispatchEdit({ type: "SET", field: "pinned", value })}
                  size="small"
                />
                <Text style={{ fontSize: 13 }}>Ghim lên đầu</Text>
              </Flex>
            </Flex>
          </Flex>
        </Modal>
      ) : null}
    </>
  );
};

export default React.memo(ReviewCard);
