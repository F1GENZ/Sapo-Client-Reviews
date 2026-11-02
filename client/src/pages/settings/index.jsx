import { useState, useMemo, useRef, useCallback, useEffect, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "../../components/layout/AdminLayout";
import {
  Input, InputNumber, Switch, ColorPicker, Card, Row, Col, Divider, Typography, Flex, Space,
  Tag, Button, Spin, Segmented, Tabs, Select, Breadcrumb, Modal,
} from "antd";
import {
  fetchSpamConfig,
  fetchWidgetConfig,
  saveSpamConfig,
  saveWidgetConfig,
} from "../../common/ApiService";
import { getStoreDomain } from "../../common/AuthStorage";
import { getErrorMessage } from "../../common/getErrorMessage";
import { shopQueryKeys } from "../../common/queryKeys";
import { toast } from "../../common/toast";
import {
  BgColorsOutlined, FormOutlined, FileTextOutlined,
  QuestionCircleOutlined, UnorderedListOutlined,
  AppstoreOutlined, SafetyOutlined, HomeOutlined,
} from "@ant-design/icons";
import Link from "../../components/StoreLink";

const { Title, Text } = Typography;

const SettingsSwitch = ({ label, ...props }) => (
  <Switch aria-label={label} size="small" {...props} />
);

const SwitchRow = ({ label, checked, onChange, hint }) => (
  <div className="f1g-switch-field">
    <label className="f1g-switch-row">
      <Switch size="small" checked={checked} onChange={onChange} />
      <span className="f1g-switch-row__text">{label}</span>
    </label>
    {hint ? <span className="f1g-switch-field__hint">{hint}</span> : null}
  </div>
);

const defaultConfig = {
  titleText: "Đánh giá sản phẩm",
  accentColor: "#f59e0b",
  starColor: "#f59e0b",
  starBgColor: "#b3bcc5",
  starIconUrl: "",
  textColor: "#1a1a1a",
  mutedColor: "#6b7280",
  bgColor: "#ffffff",
  bgAltColor: "#f8fafc",
  borderColor: "#e5e7eb",
  verifiedColor: "#01ab56",
  radius: 12,
  autoApprove: false,
  showTitle: true,
  showDate: true,
  showFilter: true,
  showSort: true,
  formEmailMode: "optional",
  formPhoneMode: "optional",
  formTitleMode: "optional",
  formContentMode: "optional",
  reviewLayout: "list",
  reviewQnaDisplayMode: "stacked",
  reviewItemsPerPage: 5,
  allowImage: true,
  allowVideo: true,
  allowQnA: true,
  qnaDisplayMode: "list",
  qnaItemsPerPage: 5,
  allowReply: true,
  replyBadgeText: "Phản hồi từ Shop",
  replyBgColor: "#f0f5ff",
  replyBorderColor: "#1677ff",
  showVerified: true,
  showVerifiedAll: false,
  requireLogin: false,
  requirePurchaseToReview: false,
  curatedSliderEnabled: true,
  curatedSliderCount: 15,
};

const WIDGET_TAB_FIELDS = {
  display: ["titleText", "showTitle", "showDate", "showFilter", "showSort", "reviewQnaDisplayMode", "reviewLayout", "reviewItemsPerPage", "allowReply", "replyBadgeText", "curatedSliderEnabled", "curatedSliderCount"],
  form: ["formContentMode", "formTitleMode", "formEmailMode", "formPhoneMode", "allowImage", "allowVideo", "requireLogin", "requirePurchaseToReview"],
  trust: ["showVerified", "showVerifiedAll", "verifiedColor"],
  qna: ["allowQnA", "qnaDisplayMode", "qnaItemsPerPage"],
  moderation: ["autoApprove"],
  appearance: ["starIconUrl", "starColor", "starBgColor", "accentColor", "textColor", "mutedColor", "bgColor", "bgAltColor", "borderColor", "radius", "replyBgColor", "replyBorderColor"],
};

const TAB_SAVE_LABELS = {
  display: "Lưu hiển thị",
  form: "Lưu form gửi",
  trust: "Lưu tin cậy",
  qna: "Lưu hỏi đáp",
  moderation: "Lưu duyệt & Spam",
  appearance: "Lưu giao diện",
};

const FORM_MODES = ["hidden", "optional", "required"];

const normalizeFormMode = (value, fallback, legacyRequired) => {
  if (FORM_MODES.includes(value)) return value;
  if (legacyRequired === true) return "required";
  if (legacyRequired === false && fallback === "required") return "optional";
  return fallback;
};

/* ── Demo data for preview ── */
const DEMO_SUMMARY = { avg: 4.2, count: 25, distribution: { 5: 10, 4: 7, 3: 4, 2: 3, 1: 1 } };
const DEMO_NAMES = [
  "Nguyễn Văn An", "Trần Thị Bích", "Lê Minh Châu", "Phạm Đức Dũng", "Hoàng Thị E",
  "Vũ Quốc Phong", "Đỗ Hải Giang", "Ngô Thanh Hà", "Bùi Quang Huy", "Đặng Thị Kim",
];
const DEMO_CONTENTS = [
  "Sản phẩm rất tốt, đúng như mô tả.", "Chất lượng ổn so với giá tiền.",
  "Mua lần 2 rồi, lần nào cũng ok.", "Giao hàng nhanh, đóng gói cẩn thận.",
  "Đẹp, bền, dùng rất thích.", "Giá cả hợp lý, sẽ mua lại.",
  "Tạm được, không có gì đặc biệt.", "Xuất sắc, vượt mong đợi!",
];
const BASE_REVIEWS = [
  {
    id: "1", rating: 5, title: "Xuất sắc, rất đáng mua!",
    content: "Sản phẩm rất tốt, đúng như mô tả. Giao hàng nhanh, đóng gói cẩn thận. Sẽ ủng hộ shop dài dài!",
    author: "Nguyễn Văn An",
    created_at: Date.now() - 86400000 * 2, verified: true,
    images: ["https://placehold.co/80x80/f59e0b/fff?text=1", "https://placehold.co/80x80/10b981/fff?text=2"],
  },
  {
    id: "2", rating: 4, title: "Hài lòng",
    content: "Chất lượng ổn so với giá tiền. Mình đã mua cho cả gia đình, ai cũng hài lòng.",
    author: "Trần Thị Bích",
    created_at: Date.now() - 86400000 * 5, verified: false,
  },
  {
    id: "3", rating: 5, title: "Sẽ mua lại!",
    content: "Mua lần 2 rồi, lần nào cũng ok. Shop tư vấn nhiệt tình lắm ạ. Sẽ giới thiệu bạn bè đến mua.",
    author: "Lê Minh Châu",
    created_at: Date.now() - 86400000 * 8, verified: false,
    video: "https://placehold.co/160x80/6366f1/fff?text=Video",
    reply: { content: "Cảm ơn bạn đã ủng hộ shop ạ! Chúc bạn sử dụng vui vẻ nhé" },
  },
];
const getReviewByIndex = (i) => {
  if (i < 3) return BASE_REVIEWS[i];
  return {
    id: String(i + 1),
    rating: (i % 5) + 1,
    title: i % 3 === 0 ? DEMO_CONTENTS[i % DEMO_CONTENTS.length].slice(0, 20) : undefined,
    content: DEMO_CONTENTS[i % DEMO_CONTENTS.length],
    author: DEMO_NAMES[i % DEMO_NAMES.length],
    created_at: Date.now() - 86400000 * (i + 1),
    verified: i % 4 === 0,
  };
};
const DEMO_QNA = [
  { id: "q1", question: "Sản phẩm này có bảo hành không ạ?", author: "Nguyễn Thị Lan", created_at: Date.now() - 86400000 * 3, answer: "Dạ có bảo hành 12 tháng chính hãng ạ. Bạn giữ hóa đơn để được hỗ trợ nhé!", answered_by: "Shop F1GENZ" },
  { id: "q2", question: "Giao hàng mất bao lâu vậy shop?", author: "Trần Văn Minh", created_at: Date.now() - 86400000 * 5, answer: "Nội thành HCM & HN: 1-2 ngày. Các tỉnh khác: 3-5 ngày ạ.", answered_by: "Shop F1GENZ" },
  { id: "q3", question: "Mình mua số lượng lớn có giảm giá không shop?", author: "Hoàng Anh Tuấn", created_at: Date.now() - 86400000 * 7 },
];

const AVATAR_COLORS = ["#f59e0b", "#10b981", "#6366f1", "#ec4899", "#8b5cf6", "#14b8a6", "#f43f5e", "#0ea5e9"];
const getAvatarColor = (name) => AVATAR_COLORS[([...name].reduce((s, c) => s + c.charCodeAt(0), 0)) % AVATAR_COLORS.length];
const getInitials = (name) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([01]?\.?\d*))?\s*\)$/i;
const COLOR_FIELDS = [
  "accentColor",
  "starColor",
  "starBgColor",
  "textColor",
  "mutedColor",
  "bgColor",
  "bgAltColor",
  "borderColor",
  "verifiedColor",
  "replyBgColor",
  "replyBorderColor",
];

const toHexChannel = (value) => value.toString(16).padStart(2, "0");
const normalizeColorValue = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (HEX_COLOR_RE.test(trimmed)) {
    if (trimmed.length === 4) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
    }
    return trimmed.toLowerCase();
  }

  const rgbMatch = trimmed.match(RGB_COLOR_RE);
  if (!rgbMatch) return trimmed;

  const [r, g, b] = rgbMatch.slice(1, 4).map((channel) => Number(channel));
  if ([r, g, b].some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    return trimmed;
  }

  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
};
const normalizeColorConfig = (config = {}) =>
  COLOR_FIELDS.reduce((acc, key) => {
    if (acc[key] !== undefined) {
      acc[key] = normalizeColorValue(acc[key], defaultConfig[key]);
    }
    return acc;
  }, { ...config });

const relativeLuminance = (hex) => {
  const value = normalizeColorValue(hex, "#000000");
  if (!HEX_COLOR_RE.test(value) || value.length !== 7) return null;
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrastWithWhite = (hex) => {
  const luminance = relativeLuminance(hex);
  if (luminance === null) return null;
  return 1.05 / (luminance + 0.05);
};

const readableTextOn = (hex) => {
  const ratio = contrastWithWhite(hex);
  return ratio !== null && ratio >= 4.5 ? "#ffffff" : "#1a1a1a";
};

const ContrastHint = ({ color }) => {
  const ratio = contrastWithWhite(color);
  if (ratio === null || ratio >= 4.5) return null;
  return (
    <Text className="f1g-contrast-warning">
      Chữ trắng trên màu này chỉ đạt {ratio.toFixed(2)}:1, dưới ngưỡng đọc tốt 4.5:1. Chọn màu đậm hơn để khách dễ đọc.
    </Text>
  );
};
const isFieldEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const normalizeLegacyWidgetConfig = (config = {}) => {
  const next = { ...config };
  next.formTitleMode = normalizeFormMode(config.formTitleMode, defaultConfig.formTitleMode);
  next.formContentMode = normalizeFormMode(config.formContentMode, defaultConfig.formContentMode, config.formContentRequired);
  next.formEmailMode = normalizeFormMode(config.formEmailMode, defaultConfig.formEmailMode);
  next.formPhoneMode = normalizeFormMode(config.formPhoneMode, defaultConfig.formPhoneMode);
  if (next.reviewQnaDisplayMode !== "tabs" && next.reviewQnaDisplayMode !== "stacked") {
    next.reviewQnaDisplayMode = defaultConfig.reviewQnaDisplayMode;
  }
  delete next.formContentRequired;
  return next;
};
const normalizeRadius = (value, fallback = defaultConfig.radius) => {
  if (value == null) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
};
const getPreviewRadiusScale = (value) => {
  const radius = normalizeRadius(value);
  return {
    radius,
    radiusSm: Math.max(0, Math.round(radius * 0.67)),
    radiusXs: Math.max(0, Math.round(radius * 0.5)),
  };
};
const timeAgo = (ts) => {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d < 1) return "Hôm nay";
  if (d < 30) return `${d} ngày trước`;
  return `${Math.floor(d / 30)} tháng trước`;
};
const isVisibleMode = (mode) => mode !== "hidden";
const requiredMark = (mode) => (mode === "required" ? " *" : "");
const getPreviewEmailMode = (config) => {
  return config.formEmailMode;
};

/* ── Color field component ── */
const ColorField = ({ label, value, onChange }) => {
  const inputId = useId();
  return (
    <div>
      <label htmlFor={inputId} className="f1g-field-label">{label}</label>
      <Flex align="center" gap={8}>
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onChange(normalizeColorValue(e.target.value, value))}
          style={{ flex: 1 }}
          size="small"
        />
        <ColorPicker
          value={normalizeColorValue(value, "#000000")}
          onChange={(color) => onChange(color.toHexString().toLowerCase())}
          size="small"
          aria-label={`Chọn ${label.toLowerCase()}`}
        />
      </Flex>
    </div>
  );
};

/* ══════════════════════════════════
   STOREFRONT PREVIEW
   ══════════════════════════════════ */
const StorefrontPreview = ({ config, reviewCount: reviewCountProp, activeTab }) => {
  const previewRadius = getPreviewRadiusScale(config.radius);
  const previewEmailMode = getPreviewEmailMode(config);
  const vars = {
    "--f1g-accent": config.accentColor,
    "--f1g-on-accent": readableTextOn(config.accentColor),
    "--f1g-star-color": config.starColor,
    "--f1g-star-empty": config.starBgColor,
    "--f1g-text": config.textColor,
    "--f1g-text-muted": config.mutedColor,
    "--f1g-bg": config.bgColor,
    "--f1g-bg-alt": config.bgAltColor,
    "--f1g-border": config.borderColor,
    "--f1g-radius": previewRadius.radius + "px",
    "--f1g-radius-sm": previewRadius.radiusSm + "px",
    "--f1g-radius-xs": previewRadius.radiusXs + "px",
    "--f1g-verified": config.verifiedColor,
    "--f1g-reply-bg": config.replyBgColor,
    "--f1g-reply-border": config.replyBorderColor,
  };

  const isGrid = config.reviewLayout === "grid";
  const isMasonry = config.reviewLayout === "masonry";
  const useSectionTabs = config.allowQnA && config.reviewQnaDisplayMode === "tabs";
  const reviewItemsPerPage = Math.max(1, Number(config.reviewItemsPerPage || 5));
  const qnaItemsPerPage = Math.max(1, Number(config.qnaItemsPerPage || 5));
  const totalReviewPages = Math.max(1, Math.ceil(reviewCountProp / reviewItemsPerPage));
  const totalQnaPages = Math.max(1, Math.ceil(DEMO_QNA.length / qnaItemsPerPage));
  const [previewReviewPage, setPreviewReviewPage] = useState(1);
  const [previewQnaPage, setPreviewQnaPage] = useState(1);
  const [previewSectionTab, setPreviewSectionTab] = useState("reviews");
  const [previewMasonryColumns, setPreviewMasonryColumns] = useState(3);
  const previewRef = useRef(null);
  const lastActiveTabRef = useRef(activeTab);

  useEffect(() => {
    if (lastActiveTabRef.current === activeTab) return;
    lastActiveTabRef.current = activeTab;
    const root = previewRef.current;
    if (!root) return;
    const scroller = root.closest(".f1g-settings-preview-card")?.querySelector(".ant-card-body");
    const scrollToBlock = (selector) => {
      if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) return;
      const block = root.querySelector(selector);
      if (!(block instanceof HTMLElement)) return;
      const offset = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, offset);
    };
    if (activeTab === "qna") {
      setPreviewSectionTab("qna");
      requestAnimationFrame(() => scrollToBlock("#f1g-preview-qna-panel"));
      return;
    }
    if (activeTab === "display" || activeTab === "appearance") {
      setPreviewSectionTab("reviews");
      scrollToBlock(".f1g-summary");
    }
  }, [activeTab]);

  const displayReviews = useMemo(() => {
    const items = [];
    const startIndex = (previewReviewPage - 1) * reviewItemsPerPage;
    const endIndex = Math.min(reviewCountProp, startIndex + reviewItemsPerPage);
    for (let i = startIndex; i < endIndex; i++) items.push(getReviewByIndex(i));
    return items;
  }, [previewReviewPage, reviewCountProp, reviewItemsPerPage]);

  const displayQna = useMemo(() => {
    const startIndex = (previewQnaPage - 1) * qnaItemsPerPage;
    return DEMO_QNA.slice(startIndex, startIndex + qnaItemsPerPage);
  }, [previewQnaPage, qnaItemsPerPage]);

  const renderedCount = displayReviews.length;

  const masonryReviewColumns = useMemo(() => {
    const columns = Array.from({ length: Math.max(1, previewMasonryColumns) }, () => []);
    displayReviews.forEach((review, index) => {
      columns[index % columns.length].push(review);
    });
    return columns;
  }, [displayReviews, previewMasonryColumns]);

  useEffect(() => {
    setPreviewReviewPage(1);
  }, [reviewCountProp, config.reviewLayout, reviewItemsPerPage]);

  useEffect(() => {
    setPreviewQnaPage(1);
  }, [config.qnaDisplayMode, qnaItemsPerPage]);

  useEffect(() => {
    if (!useSectionTabs) setPreviewSectionTab("reviews");
  }, [useSectionTabs]);

  useEffect(() => {
    if (!isMasonry) {
      setPreviewMasonryColumns(3);
      return undefined;
    }

    let resizeFrame = 0;
    const updatePreviewMasonryColumns = () => {
      if (typeof window === "undefined") return;
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        if (window.innerWidth <= 600) setPreviewMasonryColumns(1);
        else if (window.innerWidth <= 1200) setPreviewMasonryColumns(2);
        else setPreviewMasonryColumns(3);
      });
    };
    updatePreviewMasonryColumns();
    window.addEventListener("resize", updatePreviewMasonryColumns, { passive: true });
    return () => {
      window.removeEventListener("resize", updatePreviewMasonryColumns);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    };
  }, [isMasonry]);

  /* ── bars animation is handled purely by CSS @keyframes ── */

  const StarIcon = ({ filled, size = 14 }) => {
    const url = config.starIconUrl?.trim();
    if (url) {
      return (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          style={{
            width: size, height: size,
            objectFit: "contain",
            opacity: filled ? 1 : 0.25,
            flexShrink: 0,
            display: "inline-block",
            verticalAlign: "middle",
          }}
        />
      );
    }
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" style={{ color: filled ? "var(--f1g-star-color)" : "var(--f1g-star-empty)", flexShrink: 0 }}>
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
    );
  };

  const renderStars = (rating, size = 14) => (
    <span style={{ display: "inline-flex", gap: 1, alignItems: "center" }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <StarIcon key={i} filled={i <= rating} size={size} />
      ))}
    </span>
  );

  const renderPreviewPagination = (currentPage, totalPages, onChange) => {
    if (totalPages <= 1) return null;
    return (
      <div className="f1g-pagination">
        <button type="button" className="f1g-pagination__btn" onClick={() => onChange(Math.max(1, currentPage - 1))} disabled={currentPage <= 1}>Trước</button>
        {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
          <button
            key={page}
            type="button"
            className={`f1g-pagination__btn ${page === currentPage ? "f1g-pagination__btn--active" : ""}`}
            onClick={() => onChange(page)}
          >
            {page}
          </button>
        ))}
        <button type="button" className="f1g-pagination__btn" onClick={() => onChange(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages}>Sau</button>
      </div>
    );
  };

  const renderPreviewReviewCard = (r) => (
    <div key={r.id} className="f1g-card">
      <div className="f1g-card__top">
        <div className="f1g-card__avatar" style={{ background: getAvatarColor(r.author) }}>
          {getInitials(r.author)}
        </div>
        <div className="f1g-card__meta">
          <div className="f1g-card__name-row">
            <span className="f1g-card__author">{r.author}</span>
            {config.showVerified && (config.showVerifiedAll || r.verified) && (
              <span className="f1g-card__verified"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 2 }}><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Đã mua hàng</span>
            )}
            {config.showDate && <span className="f1g-card__date">{timeAgo(r.created_at)}</span>}
          </div>
          <div className="f1g-card__stars">{renderStars(r.rating, 14)}</div>
        </div>
      </div>
      {config.showTitle && r.title && (
        <div className="f1g-card__title">{r.title}</div>
      )}
      <div className="f1g-card__content">{r.content}</div>
      {((config.allowImage && r.images) || (config.allowVideo && r.video)) && (
        <div className="f1g-card__media">
          {config.allowImage && r.images && r.images.map((img, idx) => (
            <img key={idx} src={img} alt="" />
          ))}
          {config.allowVideo && r.video && (
            <div className="f1g-card__media-video">
              <img src={r.video} alt="" />
              <span className="f1g-card__media-play">▶</span>
            </div>
          )}
        </div>
      )}
      {r.reply && config.allowReply && (
        <div className="f1g-card__reply">
          <div className="f1g-card__reply-badge">{config.replyBadgeText}</div>
          <div className="f1g-card__reply-content">{r.reply.content}</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="f1g-preview" style={vars} ref={previewRef} data-active-tab={activeTab}>
      {/* ── STYLE (scoped via .f1g-preview) ── */}
      <style>{`
        .f1g-preview {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
          color: var(--f1g-text);
          line-height: 1.55;
          -webkit-font-smoothing: antialiased;
          padding: 0 4px;
        }
        .f1g-preview *, .f1g-preview *::before, .f1g-preview *::after { box-sizing: border-box; }
        .f1g-preview :where(button, a, input, select, textarea, [tabindex]):focus-visible {
          outline: 2px solid var(--f1g-accent) !important;
          outline-offset: 2px !important;
        }

        .f1g-preview .f1g-title {
          font-size: 1.25rem; font-weight: 700; margin: 0 0 1rem; color: var(--f1g-text); letter-spacing: -0.01em;
        }
        .f1g-preview .f1g-section { margin-bottom: 1.5rem; }

        /* Summary */
        .f1g-preview .f1g-summary {
          display: flex; gap: 2rem; align-items: flex-start; padding: 1.25rem;
          background: var(--f1g-bg-alt); border-radius: var(--f1g-radius); border: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-summary__score { text-align: center; min-width: 100px; flex-shrink: 0; }
        .f1g-preview .f1g-summary__avg {
          font-size: 3rem; font-weight: 800; line-height: 1; display: block; letter-spacing: -0.03em;
        }
        .f1g-preview .f1g-summary__stars { display: flex; justify-content: center; gap: 2px; margin: 0.4rem 0 0.3rem; }
        .f1g-preview .f1g-summary__count { font-size: 0.75rem; color: var(--f1g-text-muted); font-weight: 500; }
        .f1g-preview .f1g-summary__bars { flex: 1; display: flex; flex-direction: column; gap: 5px; padding-top: 6px; }
        .f1g-preview .f1g-bar-row {
          display: flex; align-items: center; gap: 8px; background: none; border: none; padding: 2px 0;
          cursor: pointer; font-family: inherit; width: 100%; transition: opacity 0.15s;
        }
        .f1g-preview .f1g-bar-row:hover { opacity: 0.75; }
        .f1g-preview .f1g-bar-row__label {
          font-size: 0.75rem; font-weight: 600; min-width: 28px; text-align: right; color: var(--f1g-text-muted); flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: flex-end; gap: 1px;
        }
        .f1g-preview .f1g-bar-row__track {
          flex: 1; height: 8px; background: var(--f1g-border); border-radius: var(--f1g-radius-xs); overflow: hidden;
        }
        .f1g-preview .f1g-bar-row__track { display: flex; }
        .f1g-preview .f1g-bar-row__fill {
          display: block; height: 100%; background: var(--f1g-star-color); border-radius: var(--f1g-radius-xs);
          width: var(--bar-pct, 0%);
          animation: f1g-bar-grow 0.4s ease-out forwards;
        }
        @keyframes f1g-bar-grow {
          from { width: 0%; }
          to   { width: var(--bar-pct, 0%); }
        }
        .f1g-preview .f1g-bar-row__count {
          font-size: 0.75rem; color: var(--f1g-text-muted); width: 22px; flex-shrink: 0; text-align: left; font-weight: 500;
        }

        /* Write review button */
        .f1g-preview .f1g-btn--write {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 32px; padding: 0 0.95rem; font-size: 0.75rem; font-weight: 600;
          border-radius: var(--f1g-radius-sm); border: none; cursor: pointer;
          background: var(--f1g-accent); color: var(--f1g-on-accent, #fff); font-family: inherit;
          transition: box-shadow 0.2s, filter 0.2s; white-space: nowrap;
        }
        .f1g-preview .f1g-btn--write:hover { filter: brightness(0.92); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }

        /* Controls */
        .f1g-preview .f1g-controls {
          display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.6rem;
          margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-controls__filters { display: flex; flex-wrap: wrap; gap: 5px; }
        .f1g-preview .f1g-controls__actions {
          margin-left: auto; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.6rem;
        }
        .f1g-preview .f1g-pill {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 0.25rem 0.6rem; font-size: 0.7rem; font-weight: 500;
          border: 1px solid var(--f1g-border); border-radius: 999px;
          background: var(--f1g-bg); color: var(--f1g-text-muted); cursor: pointer;
          transition: background-color 0.15s, border-color 0.15s, color 0.15s; font-family: inherit; white-space: nowrap;
        }
        .f1g-preview .f1g-pill:hover { border-color: var(--f1g-accent); color: var(--f1g-accent); }
        .f1g-preview .f1g-pill--active { background: var(--f1g-accent); color: var(--f1g-on-accent, #fff); border-color: var(--f1g-accent); }
        .f1g-preview .f1g-select {
          padding: 0.3rem 0.5rem; font-size: 0.75rem; border: 1px solid var(--f1g-border);
          border-radius: var(--f1g-radius-sm); background: var(--f1g-bg); color: var(--f1g-text);
          font-family: inherit; cursor: pointer;
        }

        /* Review card */
        .f1g-preview .f1g-card {
          padding: 1rem 0; border-bottom: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-card:last-child { border-bottom: none; }
        .f1g-preview .f1g-card__top { display: flex; gap: 0.6rem; align-items: flex-start; margin-bottom: 0.5rem; }
        .f1g-preview .f1g-card__avatar {
          width: 36px; height: 36px; border-radius: 50%; display: flex;
          align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700;
          color: #fff; flex-shrink: 0;
        }
        .f1g-preview .f1g-card__meta { flex: 1; min-width: 0; }
        .f1g-preview .f1g-card__name-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .f1g-preview .f1g-card__author { font-weight: 600; font-size: 0.875rem; color: var(--f1g-text); }
        .f1g-preview .f1g-card__verified {
          font-size: 0.6875rem; font-weight: 600; color: var(--f1g-verified);
          display: inline-flex; align-items: center; gap: 3px;
        }
        .f1g-preview .f1g-card__date {
          font-size: 0.6875rem; color: var(--f1g-text-muted); margin-left: auto; white-space: nowrap;
        }
        .f1g-preview .f1g-card__contact {
          font-size: 0.6875rem; color: var(--f1g-text-muted); margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap;
        }
        .f1g-preview .f1g-card__contact-item {
          display: inline-flex; align-items: center; gap: 3px;
        }
        .f1g-preview .f1g-card__stars { display: flex; gap: 1px; margin-top: 2px; }
        .f1g-preview .f1g-card__content {
          font-size: 0.85rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--f1g-text);
        }
        .f1g-preview .f1g-card__title {
          font-size: 0.9rem; font-weight: 700; color: var(--f1g-text); margin-bottom: 0.25rem;
        }
        .f1g-preview .f1g-card__media {
          display: flex; flex-wrap: wrap; gap: 6px; margin-top: 0.6rem;
        }
        .f1g-preview .f1g-card__media img {
          width: 56px; height: 56px; object-fit: cover; border-radius: var(--f1g-radius-xs); border: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-card__media-video {
          position: relative; width: 80px; height: 56px; border-radius: var(--f1g-radius-xs); overflow: hidden;
          border: 1px solid var(--f1g-border); background: #000; display: flex;
          align-items: center; justify-content: center;
        }
        .f1g-preview .f1g-card__media-video img {
          width: 100%; height: 100%; object-fit: cover; opacity: 0.7; border: none;
        }
        .f1g-preview .f1g-card__media-play {
          position: absolute; color: #fff; font-size: 1.2rem;
        }

        /* Shop reply */
        .f1g-preview .f1g-card__reply {
          margin-top: 0.6rem; padding: 0.75rem 0.875rem;
          background: var(--f1g-reply-bg); border-left: 3px solid var(--f1g-reply-border);
          border-radius: 0 var(--f1g-radius-sm) var(--f1g-radius-sm) 0;
        }
        .f1g-preview .f1g-card__reply-badge {
          font-size: 0.625rem; font-weight: 700; color: var(--f1g-reply-border);
          text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.2rem;
        }
        .f1g-preview .f1g-card__reply-content { font-size: 0.8rem; line-height: 1.5; color: var(--f1g-text); }

        /* Grid layout */
        .f1g-preview .f1g-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem;
        }
        .f1g-preview .f1g-grid .f1g-card {
          padding: 0.75rem; border: 1px solid var(--f1g-border); border-radius: var(--f1g-radius-sm);
          border-bottom: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-grid .f1g-card:last-child { border-bottom: 1px solid var(--f1g-border); }
        .f1g-preview .f1g-grid .f1g-card__content {
          display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
          overflow: hidden; text-overflow: ellipsis;
        }

        .f1g-preview .f1g-masonry {
          display: grid; grid-template-columns: repeat(var(--f1g-masonry-columns, 3), minmax(0, 1fr)); gap: 0.75rem;
        }
        .f1g-preview .f1g-masonry__column {
          display: flex; flex-direction: column; gap: 0.75rem;
        }
        .f1g-preview .f1g-masonry .f1g-card {
          width: 100%; margin: 0;
          padding: 0.75rem; border: 1px solid var(--f1g-border); border-radius: var(--f1g-radius-sm);
          border-bottom: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-masonry .f1g-card__media img,
        .f1g-preview .f1g-masonry .f1g-card__media-video {
          width: 56px; height: 56px;
        }

        /* Review list container */
        .f1g-preview .f1g-review-list { width: 100%; }

        .f1g-preview .f1g-pagination {
          display: flex; align-items: center; justify-content: center; gap: 0.4rem;
          flex-wrap: wrap; margin-top: 1rem;
        }
        .f1g-preview .f1g-pagination__btn {
          min-width: 32px; min-height: 32px; padding: 0 0.75rem;
          border: 1px solid var(--f1g-border); border-radius: var(--f1g-radius-sm);
          background: var(--f1g-bg); color: var(--f1g-text);
          font-family: inherit; font-size: 0.75rem; font-weight: 500; line-height: 1;
          cursor: pointer; transition: background-color 0.2s, border-color 0.2s, color 0.2s;
        }
        .f1g-preview .f1g-pagination__btn:hover:not(:disabled) {
          border-color: var(--f1g-accent); color: var(--f1g-accent);
        }
        .f1g-preview .f1g-pagination__btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .f1g-preview .f1g-pagination__btn--active {
          border-color: var(--f1g-accent); background: var(--f1g-accent); color: var(--f1g-on-accent, #fff);
        }

        /* Performance stats bar */
        .f1g-preview .f1g-perf-bar {
          display: flex; gap: 1rem; padding: 6px 12px; margin-bottom: 8px;
          background: #1a1a2e; border-radius: var(--f1g-radius-xs);
          font-size: 0.65rem; font-family: 'Consolas', 'Monaco', monospace;
        }
        .f1g-preview .f1g-perf-bar span { color: #4ade80; }
        .f1g-preview .f1g-perf-bar .perf-label { color: #94a3b8; }
        .f1g-preview .f1g-perf-bar .perf-warn { color: #fbbf24; }

        /* Tabs */
        .f1g-preview .f1g-tabs {
          display: flex; gap: 0; box-shadow: inset 0 -2px var(--f1g-border); margin-bottom: 1.25rem;
          min-width: 0; overflow-x: auto; overflow-y: hidden;
        }
        .f1g-preview .f1g-tab {
          min-height: 40px; padding: 0.5rem 1rem; font-size: 0.8rem; font-weight: 600;
          color: var(--f1g-text-muted); background: none; border: none;
          border-bottom: 2px solid transparent;
          cursor: pointer; transition: border-color 0.2s, color 0.2s; font-family: inherit;
          white-space: nowrap;
        }
        .f1g-preview .f1g-tab:hover { color: var(--f1g-text); }
        .f1g-preview .f1g-tab--active { color: var(--f1g-accent); border-bottom-color: var(--f1g-accent); }
        .f1g-preview .f1g-tab-panel { min-width: 0; }
        .f1g-preview .f1g-tab-panel[hidden] { display: none; }

        /* Q&A card */
        .f1g-preview .f1g-qna-card { padding: 1rem 0; border-bottom: 1px solid var(--f1g-border); }
        .f1g-preview .f1g-qna-card:last-child { border-bottom: none; }
        .f1g-preview .f1g-qna-card__top { display: flex; gap: 0.6rem; align-items: flex-start; }
        .f1g-preview .f1g-qna-card__avatar {
          width: 32px; height: 32px; border-radius: 50%; display: flex;
          align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700;
          color: #fff; flex-shrink: 0;
        }
        .f1g-preview .f1g-qna-card__meta { flex: 1; min-width: 0; }
        .f1g-preview .f1g-qna-card__author { font-weight: 600; font-size: 0.8rem; color: var(--f1g-text); }
        .f1g-preview .f1g-qna-card__date { font-size: 0.625rem; color: var(--f1g-text-muted); margin-left: 6px; }
        .f1g-preview .f1g-qna-card__question {
          font-size: 0.85rem; line-height: 1.5; margin-top: 0.3rem; color: var(--f1g-text); font-weight: 500;
        }
        .f1g-preview .f1g-qna-card__answer {
          margin-top: 0.6rem; margin-left: 2.5rem; padding: 0.75rem 0.875rem;
          background: var(--f1g-reply-bg); border-left: 3px solid var(--f1g-reply-border);
          border-radius: 0 var(--f1g-radius-sm) var(--f1g-radius-sm) 0;
        }
        .f1g-preview .f1g-qna-card__answer-badge {
          font-size: 0.625rem; font-weight: 700; color: var(--f1g-reply-border);
          text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.2rem;
        }
        .f1g-preview .f1g-qna-card__answer-text { font-size: 0.8rem; line-height: 1.5; color: var(--f1g-text); }
        .f1g-preview .f1g-qna-card__pending {
          margin-top: 0.4rem; margin-left: 2.5rem; font-size: 0.7rem;
          color: var(--f1g-text-muted); font-style: italic;
        }

        /* Q&A Grid */
        .f1g-preview .f1g-qna-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;
        }
        .f1g-preview .f1g-qna-grid .f1g-qna-card {
          padding: 0.75rem; border: 1px solid var(--f1g-border);
          border-radius: var(--f1g-radius-sm); border-bottom: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-qna-grid .f1g-qna-card:last-child { border-bottom: 1px solid var(--f1g-border); }
        .f1g-preview .f1g-qna-grid .f1g-qna-card__answer,
        .f1g-preview .f1g-qna-grid .f1g-qna-card__pending { margin-left: 0; }

        /* Load more */
        .f1g-preview .f1g-btn--outline {
          background: transparent; color: var(--f1g-text); border: 1px solid var(--f1g-border);
          width: 100%; margin-top: 1rem; padding: 0.6rem; border-radius: var(--f1g-radius-sm);
          font-weight: 600; font-family: inherit; cursor: pointer; font-size: 0.8rem;
          transition: background-color 0.2s, border-color 0.2s, color 0.2s;
        }
        .f1g-preview .f1g-btn--outline:hover {
          background: var(--f1g-bg-alt); border-color: var(--f1g-accent); color: var(--f1g-accent);
        }

        /* Ask button */
        .f1g-preview .f1g-btn--ask {
          width: auto; display: inline-flex; align-items: center; justify-content: center;
          padding: 0.6rem 1.25rem; font-size: 0.85rem; font-weight: 600;
          border-radius: var(--f1g-radius-sm); border: none; cursor: pointer;
          background: var(--f1g-accent); color: var(--f1g-on-accent, #fff); font-family: inherit;
          margin: 0; transition: filter 0.2s;
        }
        .f1g-preview .f1g-btn--ask:hover { filter: brightness(0.92); }
        .f1g-preview .f1g-qna-header__actions {
          display: inline-flex; align-items: center; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; margin-left: auto;
        }
        .f1g-preview .f1g-form-preview {
          margin: 0 0 1.25rem;
          padding: 1rem;
          border: 1px solid var(--f1g-border);
          border-radius: var(--f1g-radius);
          background: var(--f1g-bg);
        }
        .f1g-preview .f1g-form-preview__title {
          margin: 0 0 0.75rem;
          color: var(--f1g-text);
          font-size: 0.95rem;
          font-weight: 700;
        }
        .f1g-preview .f1g-form-preview__row {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0.75rem;
        }
        .f1g-preview .f1g-form-preview__field {
          margin-bottom: 0.75rem;
          min-width: 0;
        }
        .f1g-preview .f1g-form-preview__label {
          display: block;
          margin-bottom: 0.35rem;
          color: var(--f1g-text);
          font-size: 0.78rem;
          font-weight: 600;
        }
        .f1g-preview .f1g-form-preview__input,
        .f1g-preview .f1g-form-preview__textarea {
          width: 100%;
          border: 1px solid var(--f1g-border);
          border-radius: var(--f1g-radius-xs);
          background: var(--f1g-bg);
          color: var(--f1g-text);
          font: inherit;
          font-size: 0.8rem;
        }
        .f1g-preview .f1g-form-preview__input {
          height: 34px;
          padding: 0 0.65rem;
        }
        .f1g-preview .f1g-form-preview__textarea {
          min-height: 70px;
          padding: 0.55rem 0.65rem;
          resize: none;
        }
        .f1g-preview .f1g-form-preview__hint {
          margin: -0.25rem 0 0.75rem;
          color: var(--f1g-text-muted);
          font-size: 0.74rem;
          line-height: 1.45;
        }
        .f1g-preview .f1g-form-preview__media {
          display: inline-flex;
          align-items: center;
          min-height: 32px;
          padding: 0 0.75rem;
          border: 1px dashed var(--f1g-border);
          border-radius: var(--f1g-radius-xs);
          color: var(--f1g-text-muted);
          font-size: 0.78rem;
        }
        .f1g-preview .f1g-form-preview__footer {
          display: flex;
          justify-content: flex-end;
          gap: 0.5rem;
          flex-wrap: wrap;
          padding-top: 0.25rem;
          border-top: 1px solid var(--f1g-border);
        }
        .f1g-preview .f1g-form-preview__submit,
        .f1g-preview .f1g-form-preview__cancel {
          min-height: 34px;
          padding: 0 1rem;
          border-radius: var(--f1g-radius-sm);
          font: inherit;
          font-size: 0.8rem;
          font-weight: 600;
        }
        .f1g-preview .f1g-form-preview__submit {
          border: 1px solid var(--f1g-accent);
          background: var(--f1g-accent);
          color: var(--f1g-on-accent, #fff);
        }
        .f1g-preview .f1g-form-preview__cancel {
          border: 1px solid var(--f1g-border);
          background: var(--f1g-bg);
          color: var(--f1g-text);
        }
        @media (max-width: 640px) {
          .f1g-preview .f1g-form-preview__row {
            grid-template-columns: 1fr;
          }
          .f1g-preview .f1g-form-preview__footer,
          .f1g-preview .f1g-form-preview__submit,
          .f1g-preview .f1g-form-preview__cancel {
            width: 100%;
          }
        }
      `}</style>

      {useSectionTabs && (
        <div className="f1g-tabs" role="tablist" aria-label="Đánh giá và hỏi đáp">
          <button
            type="button"
            className={`f1g-tab ${previewSectionTab === "reviews" ? "f1g-tab--active" : ""}`}
            role="tab"
            aria-selected={previewSectionTab === "reviews"}
            aria-controls="f1g-preview-reviews-panel"
            id="f1g-preview-reviews-tab"
            onClick={() => setPreviewSectionTab("reviews")}
          >
            Đánh giá
          </button>
          <button
            type="button"
            className={`f1g-tab ${previewSectionTab === "qna" ? "f1g-tab--active" : ""}`}
            role="tab"
            aria-selected={previewSectionTab === "qna"}
            aria-controls="f1g-preview-qna-panel"
            id="f1g-preview-qna-tab"
            onClick={() => setPreviewSectionTab("qna")}
          >
            Hỏi đáp
          </button>
        </div>
      )}

      <div
        id="f1g-preview-reviews-panel"
        className="f1g-tab-panel"
        hidden={useSectionTabs && previewSectionTab !== "reviews"}
        role={useSectionTabs ? "tabpanel" : undefined}
        aria-labelledby={useSectionTabs ? "f1g-preview-reviews-tab" : undefined}
      >
        {/* ── Summary ── */}
        <div className="f1g-section">
        {config.showTitle && <h2 className="f1g-title">{config.titleText} ({DEMO_SUMMARY.count})</h2>}
        <div className="f1g-summary">
          <div className="f1g-summary__score">
            <span className="f1g-summary__avg">{DEMO_SUMMARY.avg}</span>
            <div className="f1g-summary__stars">
              {renderStars(Math.round(DEMO_SUMMARY.avg), 16)}
            </div>
            <span className="f1g-summary__count">{DEMO_SUMMARY.count} đánh giá</span>
          </div>
          <div className="f1g-summary__bars">
            {[5, 4, 3, 2, 1].map((star) => {
              const cnt = DEMO_SUMMARY.distribution[star] || 0;
              const pct = DEMO_SUMMARY.count > 0 ? (cnt / DEMO_SUMMARY.count) * 100 : 0;
              return (
                <button key={star} type="button" className="f1g-bar-row">
                  <span className="f1g-bar-row__label">{star}<StarIcon filled size={11} /></span>
                  <span className="f1g-bar-row__track">
                    <span className="f1g-bar-row__fill" style={{ "--bar-pct": `${pct}%` }} />
                  </span>
                  <span className="f1g-bar-row__count">{cnt}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Filters & Sort ── */}
      <div className="f1g-controls">
          {config.showFilter && (
            <div className="f1g-controls__filters">
              <button className="f1g-pill f1g-pill--active">Tất cả</button>
              {[5, 4, 3, 2, 1].map((s) => (
                <button key={s} className="f1g-pill">{s}<StarIcon filled size={11} /> ({DEMO_SUMMARY.distribution[s] || 0})</button>
              ))}
              <button className="f1g-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                Có hình ảnh
              </button>
            </div>
          )}
          <div className="f1g-controls__actions">
            {config.showSort && (
              <select className="f1g-select" defaultValue="newest">
                <option value="newest">Mới nhất</option>
                <option value="oldest">Cũ nhất</option>
              </select>
            )}
            <button type="button" className="f1g-btn--write">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -2 }}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Viết đánh giá
            </button>
          </div>
      </div>

      {/* ── Submit form preview ── */}
      <div className="f1g-form-preview">
        <h3 className="f1g-form-preview__title">
          {config.requireLogin ? "Form khi khách chưa đăng nhập" : "Form viết đánh giá"}
        </h3>
        {config.requireLogin ? (
          <div className="f1g-form-preview__hint">
            Khách chưa đăng nhập sẽ thấy nút đăng nhập trước khi gửi đánh giá.
          </div>
        ) : (
          <>
            <div className="f1g-form-preview__field">
              <span className="f1g-form-preview__label">Điểm số *</span>
              <div className="f1g-summary__stars">{renderStars(5, 18)}</div>
            </div>
            {isVisibleMode(config.formTitleMode) && (
              <div className="f1g-form-preview__field">
                <label className="f1g-form-preview__label">Tiêu đề{requiredMark(config.formTitleMode)}</label>
                <input className="f1g-form-preview__input" value="Tóm tắt đánh giá" readOnly />
              </div>
            )}
            {isVisibleMode(config.formContentMode) && (
              <div className="f1g-form-preview__field">
                <label className="f1g-form-preview__label">Nội dung{requiredMark(config.formContentMode)}</label>
                <textarea className="f1g-form-preview__textarea" value="Chia sẻ cảm nhận của bạn về sản phẩm này" readOnly />
              </div>
            )}
            <div className="f1g-form-preview__row">
              <div className="f1g-form-preview__field">
                <label className="f1g-form-preview__label">Họ Tên *</label>
                <input className="f1g-form-preview__input" value="Nguyễn Văn A" readOnly />
              </div>
              {isVisibleMode(previewEmailMode) && (
                <div className="f1g-form-preview__field">
                  <label className="f1g-form-preview__label">Email{requiredMark(previewEmailMode)}</label>
                  <input className="f1g-form-preview__input" value="email@gmail.com" readOnly />
                </div>
              )}
            </div>
            {config.requirePurchaseToReview && (
              <div className="f1g-form-preview__hint">
                Chỉ khách đã mua sản phẩm mới gửi được đánh giá. App xác minh bằng Email hoặc Số điện thoại.
              </div>
            )}
            {isVisibleMode(config.formPhoneMode) && (
              <div className="f1g-form-preview__field">
                <label className="f1g-form-preview__label">Số điện thoại{requiredMark(config.formPhoneMode)}</label>
                <input className="f1g-form-preview__input" value="0987123456" readOnly />
              </div>
            )}
            {(config.allowImage || config.allowVideo) && (
              <div className="f1g-form-preview__field">
                <span className="f1g-form-preview__label">
                  Đính kèm {config.allowImage && config.allowVideo ? "Ảnh/Video" : config.allowImage ? "Ảnh" : "Video"}
                </span>
                <span className="f1g-form-preview__media">Chọn tệp…</span>
              </div>
            )}
          </>
        )}
        <div className="f1g-form-preview__footer">
          <button type="button" className="f1g-form-preview__submit">
            {config.requireLogin ? "Đăng nhập để đánh giá" : "Gửi đánh giá"}
          </button>
          {!config.requireLogin && <button type="button" className="f1g-form-preview__cancel">Hủy</button>}
        </div>
      </div>

      {/* ── Performance Stats ── */}
      {reviewCountProp > 10 && (
        <div className="f1g-perf-bar">
          <span><span className="perf-label">Total: </span>{reviewCountProp.toLocaleString("vi-VN")}</span>
          <span><span className="perf-label">DOM: </span>{renderedCount}</span>
          <span><span className="perf-label">Mode: </span>{isMasonry ? "Masonry" : isGrid ? "Grid" : "List"}</span>
          <span><span className="perf-label">Page size: </span>{reviewItemsPerPage}</span>
        </div>
      )}

      {/* ── Review List ── */}
      <div className="f1g-review-list">
        <div
          className={isGrid ? "f1g-grid" : isMasonry ? "f1g-masonry" : ""}
          style={isMasonry ? { "--f1g-masonry-columns": previewMasonryColumns } : undefined}
        >
          {!isMasonry && displayReviews.map((r) => renderPreviewReviewCard(r))}
          {isMasonry && masonryReviewColumns.map((column, columnIndex) => (
            <div key={`masonry-col-${columnIndex}`} className="f1g-masonry__column">
              {column.map((r) => renderPreviewReviewCard(r))}
            </div>
          ))}
        </div>
      </div>
        {renderPreviewPagination(previewReviewPage, totalReviewPages, setPreviewReviewPage)}
      </div>

      {/* ── Q&A Section ── */}
      {config.allowQnA && (
        <div
          id="f1g-preview-qna-panel"
          className="f1g-tab-panel"
          hidden={useSectionTabs && previewSectionTab !== "qna"}
          role={useSectionTabs ? "tabpanel" : undefined}
          aria-labelledby={useSectionTabs ? "f1g-preview-qna-tab" : undefined}
          style={{ marginTop: useSectionTabs ? 0 : "2rem" }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.875rem" }}>
            <h3 style={{ fontSize: "0.95rem", fontWeight: 700, margin: 0, color: "var(--f1g-text)" }}>
              Hỏi đáp ({DEMO_QNA.length})
            </h3>
            <div className="f1g-qna-header__actions">
              <button type="button" className="f1g-btn--ask">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: 6, verticalAlign: -2 }}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Đặt câu hỏi
              </button>
            </div>
          </div>
          <div className={config.qnaDisplayMode === "grid" ? "f1g-qna-grid" : ""}>
            {displayQna.map((q) => (
              <div key={q.id} className="f1g-qna-card">
                <div className="f1g-qna-card__top">
                  <div className="f1g-qna-card__avatar" style={{ background: getAvatarColor(q.author) }}>
                    {getInitials(q.author)}
                  </div>
                  <div className="f1g-qna-card__meta">
                    <span className="f1g-qna-card__author">{q.author}</span>
                    {config.showDate && <span className="f1g-qna-card__date">{timeAgo(q.created_at)}</span>}
                    <div className="f1g-qna-card__question">{q.question}</div>
                  </div>
                </div>
                {q.answer ? (
                  <div className="f1g-qna-card__answer">
                    <div className="f1g-qna-card__answer-badge">{q.answered_by} trả lời</div>
                    <div className="f1g-qna-card__answer-text">{q.answer}</div>
                  </div>
                ) : (
                  <div className="f1g-qna-card__pending">Đang chờ trả lời…</div>
                )}
              </div>
            ))}
          </div>
          {renderPreviewPagination(previewQnaPage, totalQnaPages, setPreviewQnaPage)}
        </div>
      )}
    </div>
  );
};

/* ══════════════════════════════════════════════════
   SETTINGS PAGE
   ══════════════════════════════════════════════════ */
const SettingsPage = () => {
  const storeDomain = getStoreDomain();
  const [localConfig, setLocalConfig] = useState(null); // null = not yet initialized
  const u = (key, value) => setLocalConfig((prev) => ({ ...(prev ?? defaultConfig), [key]: value }));
  const [activeTabKey, setActiveTabKey] = useState("display");
  const tabsRef = useRef(null);

  /* ── Widget config: load from server ── */
  const queryClient = useQueryClient();
  const { data: savedWidgetConfig, isLoading: widgetLoading } = useQuery({
    queryKey: shopQueryKeys.widgetConfig(storeDomain),
    queryFn: fetchWidgetConfig,
    enabled: !!storeDomain,
  });

  // Initialize local config once from server; after that local edits take over
  useEffect(() => {
    if (savedWidgetConfig && localConfig === null) {
      setLocalConfig({ ...defaultConfig, ...normalizeLegacyWidgetConfig(savedWidgetConfig) });
    }
  }, [savedWidgetConfig, localConfig]);

  // Effective config: local edits > server data > defaults (never flash default colors)
  const config = localConfig ?? (savedWidgetConfig ? { ...defaultConfig, ...normalizeLegacyWidgetConfig(savedWidgetConfig) } : null);
  // Safe alias for form fields (always non-null so inputs don't crash while loading)
  const formConfig = config ?? defaultConfig;
  const normalizedSavedWidgetConfig = useMemo(
    () => ({
      ...defaultConfig,
      ...normalizeLegacyWidgetConfig(normalizeColorConfig(savedWidgetConfig || {})),
      radius: normalizeRadius(savedWidgetConfig?.radius),
    }),
    [savedWidgetConfig]
  );
  const normalizedWidgetConfig = useMemo(
    () => ({
      ...defaultConfig,
      ...normalizeLegacyWidgetConfig(normalizeColorConfig(config || {})),
      radius: normalizeRadius(config?.radius),
    }),
    [config]
  );
  const isWidgetDirty = useMemo(
    () => JSON.stringify(normalizedWidgetConfig) !== JSON.stringify(normalizedSavedWidgetConfig),
    [normalizedWidgetConfig, normalizedSavedWidgetConfig]
  );

  const widgetMutation = useMutation({
    mutationFn: (data) => saveWidgetConfig(data),
    onSuccess: (data) => {
      queryClient.setQueryData(shopQueryKeys.widgetConfig(storeDomain), data);
      setLocalConfig({ ...defaultConfig, ...(data || {}) });
      toast.success("Đã lưu cấu hình");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Lưu thất bại")),
  });

  const handleRestoreDefault = useCallback(() => {
    Modal.confirm({
      title: "Khôi phục toàn bộ về mặc định?",
      content: (
        <div>
          <p style={{ marginTop: 0 }}>Áp dụng cho toàn bộ 6 tab cấu hình widget và phần chống spam:</p>
          <ul style={{ paddingLeft: 20, margin: "0 0 8px" }}>
            <li>Hiển thị, Form gửi, Tin cậy, Hỏi đáp, Duyệt &amp; Spam, Giao diện</li>
            <li>Độ dài nội dung tối đa và danh sách từ khoá bị chặn</li>
          </ul>
          <p style={{ margin: 0 }}>Thay đổi chỉ có hiệu lực sau khi bấm “Lưu thay đổi”.</p>
        </div>
      ),
      okText: "Đưa về mặc định",
      cancelText: "Hủy",
      okButtonProps: { danger: true },
      onOk: () => {
        setLocalConfig({ ...defaultConfig });
        setSpamDraft({});
      },
    });
  }, []);

  /* ── Spam config ── */
  const { data: spamConfig, isLoading: spamLoading } = useQuery({
    queryKey: shopQueryKeys.spamConfig(storeDomain),
    queryFn: fetchSpamConfig,
    enabled: !!storeDomain,
  });
  const [spamDraft, setSpamDraft] = useState(null);
  const spam = spamDraft ?? spamConfig ?? {};
  const us = (key, value) => setSpamDraft((prev) => ({ ...(prev ?? spamConfig ?? {}), [key]: value }));

  const [blockedWordInput, setBlockedWordInput] = useState("");
  const addBlockedWord = () => {
    const w = blockedWordInput.trim();
    if (!w) return;
    const list = [...(spam.blockedWords || [])];
    if (!list.includes(w)) list.push(w);
    us("blockedWords", list);
    setBlockedWordInput("");
  };
  const removeBlockedWord = (word) => {
    us("blockedWords", (spam.blockedWords || []).filter((w) => w !== word));
  };

  const spamMutation = useMutation({
    mutationFn: (data) => saveSpamConfig(data),
    onSuccess: (data) => {
      queryClient.setQueryData(shopQueryKeys.spamConfig(storeDomain), data);
      setSpamDraft(null);
      toast.success("Đã lưu cấu hình spam");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Lưu thất bại")),
  });

  const widgetTabDirtyMap = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(WIDGET_TAB_FIELDS).map(([tabKey, fields]) => [
          tabKey,
          fields.some((field) => !isFieldEqual(normalizedWidgetConfig[field], normalizedSavedWidgetConfig[field])),
        ])
      ),
    [normalizedWidgetConfig, normalizedSavedWidgetConfig]
  );
  const isSpamDirty = useMemo(
    () => spamDraft !== null && !isFieldEqual(spamDraft, spamConfig ?? {}),
    [spamDraft, spamConfig]
  );
  const tabDirtyMap = useMemo(
    () => ({
      ...widgetTabDirtyMap,
      moderation: Boolean(widgetTabDirtyMap.moderation || isSpamDirty),
    }),
    [widgetTabDirtyMap, isSpamDirty]
  );

  const isDirty = isWidgetDirty || isSpamDirty;

  const handleTabChange = useCallback((nextKey) => {
    setActiveTabKey(nextKey);
    requestAnimationFrame(() => {
      const holder = tabsRef.current?.querySelector(".ant-tabs-content-holder");
      if (holder) holder.scrollTop = 0;
    });
  }, []);

  const handleSave = useCallback(async () => {
    const tasks = [];
    if (isWidgetDirty) {
      tasks.push(widgetMutation.mutateAsync(normalizedWidgetConfig));
    }
    if (isSpamDirty) {
      tasks.push(spamMutation.mutateAsync(spam));
    }
    if (!tasks.length) return;
    try {
      await Promise.all(tasks);
    } catch {
      // Mutation handlers already show the actionable error message.
    }
  }, [isSpamDirty, isWidgetDirty, normalizedWidgetConfig, spam, spamMutation, widgetMutation]);

  useEffect(() => {
    if (!isDirty) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isDirty]);

  const saving = widgetMutation.isPending || spamMutation.isPending;
  const tabLabel = useCallback((key, label) => (
    <span className="f1g-tab-label">
      {label}
      {tabDirtyMap[key] ? <span className="f1g-tab-dot" aria-label="Có thay đổi chưa lưu" /> : null}
    </span>
  ), [tabDirtyMap]);

  const settingsTabItems = [
    {
      key: "display",
      label: tabLabel("display", "Hiển thị"),
      icon: <UnorderedListOutlined />,
      children: (
        <>
          <Flex vertical gap={14}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Quản lý cách danh sách đánh giá xuất hiện trên trang sản phẩm.
            </Text>
            <div>
              <label htmlFor="f1g-title-text" className="f1g-field-label">Tiêu đề widget</label>
              <Input
                id="f1g-title-text"
                value={formConfig.titleText}
                onChange={(e) => u("titleText", e.target.value)}
                size="small"
              />
            </div>
            <Divider style={{ margin: "2px 0" }} />
            <Flex vertical gap={10}>
              <Text strong style={{ fontSize: 13 }}>Thông tin trong từng đánh giá</Text>
              <SwitchRow label="Hiển thị tiêu đề đánh giá" checked={formConfig.showTitle} onChange={(v) => u("showTitle", v)} />
              <SwitchRow label="Hiển thị thời gian đánh giá" checked={formConfig.showDate} onChange={(v) => u("showDate", v)} />
              <SwitchRow label="Hiển thị bộ lọc đánh giá" checked={formConfig.showFilter} onChange={(v) => u("showFilter", v)} />
              <SwitchRow label="Hiển thị sắp xếp đánh giá" checked={formConfig.showSort} onChange={(v) => u("showSort", v)} />
            </Flex>
            <Divider style={{ margin: "2px 0" }} />
            <div>
              <Text strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>Bố cục Review & Hỏi đáp</Text>
              <Segmented
                aria-label="Bố cục Review và Hỏi đáp"
                value={formConfig.reviewQnaDisplayMode}
                onChange={(v) => u("reviewQnaDisplayMode", v)}
                size="small"
                options={[
                  { value: "stacked", label: "Xếp dọc" },
                  { value: "tabs", label: "2 tab" },
                ]}
              />
              <Text type="secondary" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
                Chế độ 2 tab áp dụng cho snippet tổng <Text code>{"<f1genz-reviews>"}</Text>.
              </Text>
            </div>
            <div>
              <Text strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>Kiểu danh sách đánh giá</Text>
              <Segmented
                aria-label="Kiểu danh sách đánh giá"
                value={formConfig.reviewLayout}
                onChange={(v) => u("reviewLayout", v)}
                size="small"
                options={[
                  { value: "list", icon: <UnorderedListOutlined />, label: "Danh sách" },
                  { value: "grid", icon: <AppstoreOutlined />, label: "Lưới" },
                  { value: "masonry", label: "Xếp gạch" },
                ]}
              />
            </div>
            <div>
              <label htmlFor="f1g-review-page-size" className="f1g-field-label">Số đánh giá mỗi trang</label>
              <InputNumber
                id="f1g-review-page-size"
                aria-label="Số đánh giá mỗi trang"
                min={1}
                max={50}
                size="small"
                style={{ width: "100%" }}
                value={formConfig.reviewItemsPerPage}
                onChange={(v) => u("reviewItemsPerPage", v ?? 5)}
              />
            </div>
            <Divider style={{ margin: "2px 0" }} />
            <Flex vertical gap={10}>
              <Flex vertical gap={2}>
                <Text strong style={{ fontSize: 13 }}>Dải đánh giá nổi bật (slider)</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Hiển thị ở phần tử <Text code>{"<f1genz-curated-slider>"}</Text> nếu theme đã gắn phần tử này.
                </Text>
              </Flex>
              <SwitchRow
                label="Bật dải đánh giá nổi bật"
                checked={formConfig.curatedSliderEnabled !== false}
                onChange={(v) => u("curatedSliderEnabled", v)}
              />
              {formConfig.curatedSliderEnabled !== false && (
                <div>
                  <label htmlFor="f1g-slider-count" className="f1g-field-label">Số đánh giá trong dải (5–15)</label>
                  <InputNumber
                    id="f1g-slider-count"
                    aria-label="Số đánh giá trong dải nổi bật"
                    min={5}
                    max={15}
                    precision={0}
                    size="small"
                    style={{ width: "100%" }}
                    value={formConfig.curatedSliderCount ?? 15}
                    onChange={(v) => u("curatedSliderCount", v ?? 15)}
                  />
                </div>
              )}
            </Flex>
            <Divider style={{ margin: "2px 0" }} />
            <Flex vertical gap={10}>
              <Flex vertical gap={2}>
                <Text strong style={{ fontSize: 13 }}>Phản hồi của shop</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>Điều khiển phần trả lời hiển thị dưới review.</Text>
              </Flex>
              <SwitchRow label="Hiển thị phản hồi của shop" checked={formConfig.allowReply} onChange={(v) => u("allowReply", v)} />
              {formConfig.allowReply && (
                <div>
                  <label htmlFor="f1g-reply-badge-text" className="f1g-field-label">Nhãn phản hồi</label>
                  <Input
                    id="f1g-reply-badge-text"
                    value={formConfig.replyBadgeText}
                    onChange={(e) => u("replyBadgeText", e.target.value)}
                    size="small"
                    placeholder="VD: Phản hồi từ Shop, Hỗ trợ khách hàng, Admin…"
                    maxLength={50}
                    showCount
                  />
                </div>
              )}
            </Flex>
          </Flex>
        </>
      ),
    },
    {
      key: "form",
      label: tabLabel("form", "Form gửi"),
      icon: <FormOutlined />,
      children: (
        <>
          <Flex vertical gap={14}>
            <Text type="secondary" style={{ fontSize: 12 }}>Cấu hình form khách dùng để gửi đánh giá trên storefront.</Text>
            <Flex vertical gap={2}>
              <Text strong style={{ fontSize: 13 }}>Trường nội dung review</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>Tên khách và số sao luôn bắt buộc.</Text>
            </Flex>
            <div>
              <label htmlFor="f1g-form-title-mode" className="f1g-field-label">Trường tiêu đề</label>
              <Select
                id="f1g-form-title-mode"
                aria-label="Trường tiêu đề"
                value={formConfig.formTitleMode}
                onChange={(v) => u("formTitleMode", v)}
                size="small"
                style={{ width: "100%" }}
                options={[
                  { label: "Ẩn", value: "hidden" },
                  { label: "Không bắt buộc", value: "optional" },
                  { label: "Bắt buộc", value: "required" },
                ]}
              />
            </div>
            <div>
              <label htmlFor="f1g-form-content-mode" className="f1g-field-label">Trường nội dung</label>
              <Select
                id="f1g-form-content-mode"
                aria-label="Trường nội dung"
                value={formConfig.formContentMode}
                onChange={(v) => u("formContentMode", v)}
                size="small"
                style={{ width: "100%" }}
                options={[
                  { label: "Ẩn", value: "hidden" },
                  { label: "Không bắt buộc", value: "optional" },
                  { label: "Bắt buộc", value: "required" },
                ]}
              />
            </div>
            <div>
              <label htmlFor="f1g-form-email-mode" className="f1g-field-label">Trường email</label>
              <Select
                id="f1g-form-email-mode"
                aria-label="Trường email"
                value={formConfig.formEmailMode}
                onChange={(v) => u("formEmailMode", v)}
                size="small"
                style={{ width: "100%" }}
                options={[
                  { label: "Ẩn", value: "hidden" },
                  { label: "Không bắt buộc", value: "optional" },
                  { label: "Bắt buộc", value: "required" },
                ]}
              />
            </div>
            <div>
              <label htmlFor="f1g-form-phone-mode" className="f1g-field-label">Trường số điện thoại</label>
              <Select
                id="f1g-form-phone-mode"
                aria-label="Trường số điện thoại"
                value={formConfig.formPhoneMode}
                onChange={(v) => u("formPhoneMode", v)}
                size="small"
                style={{ width: "100%" }}
                options={[
                  { label: "Ẩn", value: "hidden" },
                  { label: "Không bắt buộc", value: "optional" },
                  { label: "Bắt buộc", value: "required" },
                ]}
              />
            </div>
            <Divider style={{ margin: "2px 0" }} />
            <Flex vertical gap={10}>
              <Text strong style={{ fontSize: 13 }}>Media đính kèm</Text>
              <SwitchRow label="Cho phép hình ảnh đánh giá" checked={formConfig.allowImage} onChange={(v) => u("allowImage", v)} />
              <SwitchRow label="Cho phép video đánh giá" checked={formConfig.allowVideo} onChange={(v) => u("allowVideo", v)} />
            </Flex>
            <Divider style={{ margin: "2px 0" }} />
            <Flex vertical gap={10}>
              <Text strong style={{ fontSize: 13 }}>Điều kiện gửi đánh giá</Text>
              <SwitchRow
                label="Bắt buộc đăng nhập để đánh giá"
                checked={formConfig.requireLogin}
                onChange={(v) => u("requireLogin", v)}
                hint="Khách chưa đăng nhập sẽ thấy CTA đăng nhập trước khi mở form."
              />
              <SwitchRow
                label="Chỉ khách đã mua hàng mới được đánh giá"
                checked={formConfig.requirePurchaseToReview}
                onChange={(v) => u("requirePurchaseToReview", v)}
                hint="Xác minh bằng email hoặc số điện thoại trong dữ liệu đơn hàng."
              />
              {formConfig.requirePurchaseToReview && (
                <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: 10 }}>
                  <Text style={{ display: "block", fontSize: 12, color: "#9a3412" }}>
                    Theme cần truyền customer-email/customer-phone và dữ liệu đơn hàng phải được sync. Nếu chưa có identity, storefront sẽ chặn form và yêu cầu đăng nhập.
                  </Text>
                </div>
              )}
            </Flex>
          </Flex>
        </>
      ),
    },
    {
      key: "trust",
      label: tabLabel("trust", "Tin cậy"),
      icon: <SafetyOutlined />,
      children: (
        <>
          <Flex vertical gap={14}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Quản lý các tín hiệu giúp khách hiểu review nào đến từ người đã mua hàng.
            </Text>
            <Flex vertical gap={2}>
              <SwitchRow label="Hiển thị badge “Đã mua hàng”" checked={formConfig.showVerified} onChange={(v) => u("showVerified", v)} />
              <Text type="secondary" style={{ fontSize: 12 }}>Badge chỉ hiển thị cho review có trạng thái verified.</Text>
            </Flex>
            {formConfig.showVerified && (
              <>
                <div className="f1g-color-field-group">
                  <ColorField label="Màu badge “Đã mua hàng”" value={formConfig.verifiedColor} onChange={(v) => u("verifiedColor", v)} />
                  <ContrastHint color={formConfig.verifiedColor} />
                </div>
                <Flex vertical gap={2}>
                  <SwitchRow label="Hiển thị badge cho mọi đánh giá" checked={formConfig.showVerifiedAll} onChange={(v) => u("showVerifiedAll", v)} />
                  <Text type="secondary" style={{ fontSize: 12, color: "#b45309" }}>
                    Không khuyến nghị bật ngoài dữ liệu demo, vì khách có thể hiểu mọi review đều đã được xác minh mua hàng.
                  </Text>
                </Flex>
              </>
            )}
          </Flex>
        </>
      ),
    },
    {
      key: "qna",
      label: tabLabel("qna", "Hỏi đáp"),
      icon: <QuestionCircleOutlined />,
      children: (
        <>
          <Flex vertical gap={14}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Cấu hình khối hỏi đáp sản phẩm hiển thị bên cạnh review.
            </Text>
            <SwitchRow label="Cho phép hỏi đáp sản phẩm" checked={formConfig.allowQnA} onChange={(v) => u("allowQnA", v)} />
            {formConfig.allowQnA && (
              <>
                <div>
                  <Text strong style={{ fontSize: 12, display: "block", marginBottom: 6 }}>Kiểu hiển thị</Text>
                  <Segmented
                    aria-label="Kiểu hiển thị hỏi đáp"
                    value={formConfig.qnaDisplayMode}
                    onChange={(v) => u("qnaDisplayMode", v)}
                    size="small"
                    options={[
                      { value: "list", icon: <UnorderedListOutlined />, label: "Danh sách" },
                      { value: "grid", icon: <AppstoreOutlined />, label: "Lưới" },
                    ]}
                  />
                </div>
                <div>
                  <label htmlFor="f1g-qna-page-size" className="f1g-field-label">Số câu hỏi mỗi trang</label>
                  <InputNumber
                    id="f1g-qna-page-size"
                    aria-label="Số câu hỏi mỗi trang"
                    min={1}
                    max={50}
                    size="small"
                    style={{ width: "100%" }}
                    value={formConfig.qnaItemsPerPage}
                    onChange={(v) => u("qnaItemsPerPage", v ?? 5)}
                  />
                </div>
              </>
            )}
          </Flex>
        </>
      ),
    },
    {
      key: "moderation",
      label: tabLabel("moderation", "Duyệt & Spam"),
      icon: <FileTextOutlined />,
      children: (
        <>
          <Flex vertical gap={14}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Điều khiển trạng thái review mới và các luật chống spam.
            </Text>
            <Flex vertical gap={2}>
              <Text strong style={{ fontSize: 13 }}>Duyệt đánh giá</Text>
              <SwitchRow label="Tự động duyệt review mới từ storefront" checked={formConfig.autoApprove} onChange={(v) => u("autoApprove", v)} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                Tắt để review mới vào trạng thái chờ duyệt trước khi hiển thị công khai.
              </Text>
            </Flex>
            <Divider style={{ margin: "2px 0" }} />
            {spamLoading ? (
              <Flex justify="center" style={{ padding: 24 }}><Spin /></Flex>
            ) : (
              <>
                <Flex vertical gap={10}>
                  <Text strong style={{ fontSize: 13 }}>Luật chống spam</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Review chứa từ khoá bị chặn, vượt độ dài tối đa hoặc trùng nội dung cũ của cùng tác giả sẽ vào mục Spam.
                  </Text>
                  <div>
                    <label htmlFor="f1g-spam-max-length" className="f1g-field-label">Độ dài nội dung tối đa</label>
                    <Space.Compact style={{ width: "100%" }}>
                      <InputNumber id="f1g-spam-max-length" aria-label="Độ dài nội dung tối đa" value={spam.maxContentLength ?? 5000} onChange={(v) => us("maxContentLength", v ?? 5000)} min={1} max={5000} precision={0} size="small" style={{ width: "100%" }} />
                      <Button size="small" disabled style={{ width: 58 }}>ký tự</Button>
                    </Space.Compact>
                  </div>
                </Flex>
                <Divider style={{ margin: "4px 0" }} />
                <div>
                  <label htmlFor="f1g-spam-blocked-word" className="f1g-field-label">Từ khoá bị chặn</label>
                  <Flex wrap="wrap" gap={4} style={{ marginBottom: 6 }}>
                    {(spam.blockedWords || []).map((w) => (
                      <Tag key={w} closable onClose={() => removeBlockedWord(w)} style={{ margin: 0 }}>{w}</Tag>
                    ))}
                  </Flex>
                  <Input id="f1g-spam-blocked-word" aria-label="Thêm từ khoá bị chặn" size="small" placeholder="Nhập từ khoá rồi Enter" value={blockedWordInput} onChange={(e) => setBlockedWordInput(e.target.value)} onPressEnter={addBlockedWord} />
                </div>
              </>
            )}
          </Flex>
        </>
      ),
    },
    {
      key: "appearance",
      label: tabLabel("appearance", "Giao diện"),
      icon: <BgColorsOutlined />,
      children: (
        <>
          <Flex vertical gap={14}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Tùy chỉnh màu sắc, bo góc và style nền của widget.
            </Text>
            <div>
              <label htmlFor="f1g-star-icon-url" className="f1g-field-label">Hình ngôi sao (URL)</label>
              <Input
                id="f1g-star-icon-url"
                value={formConfig.starIconUrl || ""}
                onChange={(e) => u("starIconUrl", e.target.value)}
                placeholder="https://… (để trống dùng icon mặc định)"
                size="small"
                allowClear
              />
              {formConfig.starIconUrl?.trim() && (
                <Flex align="center" gap={6} style={{ marginTop: 6 }}>
                  {[1,2,3,4,5].map((i) => (
                    <img key={i} src={formConfig.starIconUrl} alt="" width={18} height={18} style={{ objectFit: "contain", opacity: i <= 4 ? 1 : 0.25 }} />
                  ))}
                  <Text type="secondary" style={{ fontSize: 12 }}>Xem trước</Text>
                </Flex>
              )}
            </div>
            <ColorField label="Màu icon sao" value={formConfig.starColor} onChange={(v) => u("starColor", v)} />
            <ColorField label="Màu sao chưa chọn" value={formConfig.starBgColor} onChange={(v) => u("starBgColor", v)} />
            <Divider style={{ margin: "2px 0" }} />
            <div className="f1g-color-field-group">
              <ColorField label="Màu chủ đạo" value={formConfig.accentColor} onChange={(v) => u("accentColor", v)} />
              <ContrastHint color={formConfig.accentColor} />
            </div>
            <ColorField label="Màu chữ" value={formConfig.textColor} onChange={(v) => u("textColor", v)} />
            <ColorField label="Màu chữ phụ" value={formConfig.mutedColor} onChange={(v) => u("mutedColor", v)} />
            <ColorField label="Nền chính" value={formConfig.bgColor} onChange={(v) => u("bgColor", v)} />
            <ColorField label="Nền phụ" value={formConfig.bgAltColor} onChange={(v) => u("bgAltColor", v)} />
            <ColorField label="Viền" value={formConfig.borderColor} onChange={(v) => u("borderColor", v)} />
            <div>
              <label htmlFor="f1g-radius" className="f1g-field-label">Bo góc</label>
              <Space.Compact style={{ width: "100%" }}>
                <InputNumber id="f1g-radius" aria-label="Bo góc" value={formConfig.radius} onChange={(v) => u("radius", v ?? 12)} min={0} max={99} size="small" style={{ width: "100%" }} />
                <Button size="small" disabled style={{ width: 44 }}>px</Button>
              </Space.Compact>
            </div>
            <Divider style={{ margin: "2px 0" }} />
            <Flex vertical gap={2}>
              <Text strong style={{ fontSize: 13 }}>Màu phản hồi của shop</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>Dùng cho khối phản hồi đánh giá và câu trả lời hỏi đáp trên storefront.</Text>
            </Flex>
            <ColorField label="Màu nền phản hồi" value={formConfig.replyBgColor} onChange={(v) => u("replyBgColor", v)} />
            <ColorField label="Màu viền trái phản hồi" value={formConfig.replyBorderColor} onChange={(v) => u("replyBorderColor", v)} />
          </Flex>
        </>
      ),
    },
  ];

  return (
    <AdminLayout>
      <style>{`
        .f1g-settings-page {
          height: calc(100vh - 48px);
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .f1g-settings-heading {
          flex-shrink: 0;
        }
        .f1g-settings-heading .ant-breadcrumb {
          margin-bottom: 10px !important;
        }
        .f1g-settings-heading .ant-typography {
          margin-bottom: 14px !important;
        }
        .f1g-settings-workspace {
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .f1g-settings-col--config,
        .f1g-settings-col--preview {
          min-height: 0;
          height: 100%;
        }
        .f1g-settings-col--config .ant-spin-nested-loading,
        .f1g-settings-col--config .ant-spin-container {
          height: 100%;
          min-height: 0;
        }
        @media (min-width: 992px) {
          .f1g-settings-col--config {
            flex: 0 0 50% !important;
            max-width: 50% !important;
          }
          .f1g-settings-col--preview {
            flex: 0 0 50% !important;
            max-width: 50% !important;
          }
        }
        .f1g-settings-card .ant-card-body {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          padding: 0 16px 0 !important;
        }
        .f1g-settings-card,
        .f1g-settings-preview-card {
          height: 100%;
          min-height: 0;
        }
        .f1g-settings-tabs-scroll {
          flex: 1;
          min-height: 0;
          display: flex;
          overflow: hidden;
          padding-bottom: 12px;
        }
        .f1g-settings-tabs-scroll .ant-tabs {
          flex: 1;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .f1g-settings-tabs-scroll .ant-tabs-nav {
          flex-shrink: 0;
          margin: 0 !important;
          background: #fff;
          z-index: 2;
        }
        .f1g-settings-tabs-scroll .ant-tabs-content-holder {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 12px 14px 0 0;
          scrollbar-gutter: stable;
        }
        .f1g-settings-tabs-scroll .ant-tabs-content,
        .f1g-settings-tabs-scroll .ant-tabs-tabpane {
          min-height: 0;
        }
        .f1g-settings-footer {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 12px;
          padding: 12px 0;
          background: #fff;
          border-top: 1px solid #f0f0f0;
        }
        .f1g-settings-footer__status {
          font-size: 12px;
          color: #475569;
        }
        .f1g-settings-footer__status--dirty {
          color: #b45309;
          font-weight: 600;
        }
        .f1g-settings-footer__actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-left: auto;
        }
        .f1g-settings-footer .ant-btn {
          height: 32px;
        }
        .f1g-field-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 6px;
        }
        .f1g-switch-field {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .f1g-switch-row {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          min-height: 24px;
          cursor: pointer;
        }
        .f1g-switch-row__text {
          font-size: 13px;
        }
        .f1g-switch-field__hint {
          font-size: 12px;
          color: #64748b;
        }
        .f1g-color-field-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .f1g-contrast-warning {
          font-size: 12px;
          color: #b45309;
        }
        .f1g-tab-label {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .f1g-preview-title {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .f1g-tab-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #d97706;
          flex-shrink: 0;
        }
        .f1g-settings-tabs-scroll .ant-tabs-content-holder {
          overscroll-behavior: contain;
        }
        @media (max-width: 1199px) {
          .f1g-settings-tabs-scroll .ant-tabs-tab .anticon {
            display: none;
          }
        }
        .f1g-settings-preview-card {
          display: flex;
          flex-direction: column;
        }
        .f1g-settings-preview-card .ant-card-head {
          flex-shrink: 0;
        }
        .f1g-settings-preview-card .ant-card-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        @media (max-width: 991px) {
          .f1g-settings-page {
            height: auto;
            overflow: visible;
          }
          .f1g-settings-workspace {
            overflow: visible;
          }
          .f1g-settings-col--config,
          .f1g-settings-col--preview {
            height: auto;
          }
          .f1g-settings-card .ant-card-body,
          .f1g-settings-card,
          .f1g-settings-col--config .ant-spin-nested-loading,
          .f1g-settings-col--config .ant-spin-container {
            height: auto;
          }
          .f1g-settings-tabs-scroll {
            overflow: visible;
          }
          .f1g-settings-tabs-scroll .ant-tabs-content-holder {
            overflow: visible;
            padding-right: 0;
          }
          .f1g-settings-footer {
            position: sticky;
            bottom: 0;
            z-index: 3;
          }
          .f1g-settings-col--preview {
            margin-top: 16px;
          }
        }
        @media (max-width: 575px) {
          .f1g-settings-footer__actions {
            width: 100%;
            margin-left: 0;
          }
          .f1g-settings-footer__actions .ant-btn {
            flex: 1;
          }
        }
      `}</style>
      <div className="f1g-settings-page">
        <div className="f1g-settings-heading">
          <Breadcrumb
            items={[
              { title: <Link to="/"><HomeOutlined /></Link> },
              { title: "Cấu hình" },
            ]}
          />
          <Title level={4}>Cấu hình</Title>
        </div>

      <Row gutter={24} className="f1g-settings-workspace">
        {/* Left: Config panel */}
        <Col xs={24} lg={12} className="f1g-settings-col--config">
          <Spin spinning={widgetLoading}>
          <Card
            className="f1g-settings-card"
            style={{ borderRadius: 12, border: "none", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}
          >
            <div className="f1g-settings-tabs-scroll" ref={tabsRef}>
            <Tabs
              activeKey={activeTabKey}
              size="small"
              onChange={handleTabChange}
              tabBarGutter={16}
              items={settingsTabItems}
              more={{ icon: <span aria-hidden="true">…</span> }}
            />
            </div>
            <div className="f1g-settings-footer">
              <span className={`f1g-settings-footer__status${isDirty ? " f1g-settings-footer__status--dirty" : ""}`}>
                {isDirty ? "Có thay đổi chưa lưu" : "Chưa có thay đổi"}
              </span>
              <div className="f1g-settings-footer__actions">
                <Button
                  disabled={saving}
                  onClick={handleRestoreDefault}
                >
                  Khôi phục toàn bộ mặc định
                </Button>
                <Button
                  type="primary"
                  loading={saving}
                  disabled={!config || saving || !isDirty}
                  onClick={() => void handleSave()}
                >
                  Lưu thay đổi
                </Button>
              </div>
            </div>
          </Card>
          </Spin>
        </Col>

        {/* Right: Live preview */}
        <Col xs={24} lg={12} className="f1g-settings-col--preview">
          <Card
            className="f1g-settings-preview-card"
            style={{ borderRadius: 12, border: "none", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}
            styles={{
              header: { borderBottom: "1px solid #f0f0f0", padding: "12px 24px" },
              body: { padding: "24px", background: config?.bgColor ?? "#fff", borderRadius: "0 0 12px 12px" },
            }}
            title={
              <span className="f1g-preview-title">
                <span style={{ fontSize: 14, fontWeight: 600 }}>Xem trước Storefront</span>
                <Tag bordered={false} color="default" icon={<FileTextOutlined />}>Dữ liệu minh họa</Tag>
              </span>
            }
          >
            {widgetLoading || !config ? (
              <div style={{ padding: "60px 0", textAlign: "center" }}>
                <Spin size="large" />
              </div>
            ) : (
              <StorefrontPreview config={config} reviewCount={3} activeTab={activeTabKey} />
            )}
          </Card>
        </Col>
      </Row>

      </div>
    </AdminLayout>
  );
};

export default SettingsPage;
