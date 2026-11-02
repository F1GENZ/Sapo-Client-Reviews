import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bulkReviews,
  deleteReview,
  exportReviews,
  fetchAllReviews,
  fetchDashboardOverview,
  fetchProduct,
  fetchProducts,
  fetchReviews,
  fetchReviewSummary,
  importReviews,
  replyToReview,
  updateReview,
  updateReviewStatus,
} from "../../common/ApiService";
import { getStoreDomain } from "../../common/AuthStorage";
import { shopQueryKeys } from "../../common/queryKeys";
import { buildProductUrl } from "../../common/storeUrl";
import AdminLayout from "../../components/layout/AdminLayout";
import StatCard from "../../components/dashboard/StatCard";
import ReviewCard from "../../components/review/ReviewCard";
import ReviewForm from "../../components/review/ReviewForm";
import RatingSummary from "../../components/review/RatingSummary";
import ProductSearch from "../../components/ProductSearch";
import {
  BulkActionBar,
  ExportMenu,
  ImportModal,
  downloadExport,
} from "../../components/DataTools";
import {
  Badge,
  Breadcrumb,
  Button,
  Checkbox,
  Col,
  Empty,
  Flex,
  Grid,
  Modal,
  Pagination,
  Row,
  Select,
  Segmented,
  Space,
  Spin,
  Tabs,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  CommentOutlined,
  EyeOutlined,
  HomeOutlined,
  MessageOutlined,
  PlusOutlined,
  StarFilled,
  UnorderedListOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import { toast } from "../../common/toast";
import { getErrorMessage } from "../../common/getErrorMessage";
import Link from "../../components/StoreLink";

const { Text, Title } = Typography;
const { useBreakpoint } = Grid;
const STAR_FILTERS = [5, 4, 3, 2, 1];
const ALL_REVIEWS_PAGE_SIZE = 20;

const isGenericProductLabel = (value, productId) =>
  Boolean(productId && String(value || "").trim() === `Sản phẩm #${productId}`);

const STATUS_CONFIG = {
  all: { label: "Tất cả" },
  approved: { label: "Đã duyệt", color: "success" },
  pending: { label: "Chờ duyệt", color: "warning" },
  hidden: { label: "Đã ẩn", color: "default" },
  spam: { label: "Spam", color: "error" },
  unreplied: { label: "Chưa phản hồi", color: "purple" },
};

const EMPTY_STATUS_COUNTS = {
  all: 0,
  approved: 0,
  pending: 0,
  hidden: 0,
  spam: 0,
  unreplied: 0,
};

const ReviewGridCell = memo(({
  review,
  productId,
  productUrl,
  onDelete,
  onReply,
  onEdit,
  onStatusChange,
  selected,
  onToggleSelect,
}) => (
  <Col xs={24} sm={12} xl={8}>
    <div className={`f1g-bulk-table__grid-card${selected ? " f1g-bulk-table__grid-card--selected" : ""}`}>
      {onToggleSelect ? (
        <label className="f1g-bulk-table__select">
          <Checkbox checked={selected} onChange={onToggleSelect} />
          <span className="f1g-bulk-table__select-text">Chọn</span>
        </label>
      ) : null}
      <ReviewCard
        review={review}
        productId={productId}
        productUrl={productUrl}
        onDelete={onDelete}
        onReply={onReply}
        onEdit={onEdit}
        onStatusChange={onStatusChange}
        compact
      />
    </div>
  </Col>
));
ReviewGridCell.displayName = "ReviewGridCell";

const ReviewTableRow = memo(({
  review,
  productId,
  productUrl,
  onDelete,
  onReply,
  onEdit,
  onStatusChange,
  selected,
  onToggleSelect,
}) => (
  <div className={`f1g-bulk-table__row${selected ? " f1g-bulk-table__row--selected" : ""}`}>
    {onToggleSelect ? (
      <label className="f1g-bulk-table__select">
        <Checkbox checked={selected} onChange={onToggleSelect} />
        <span className="f1g-bulk-table__select-text">Chọn đánh giá {review.author || ""}</span>
      </label>
    ) : null}
    <ReviewCard
      review={review}
      productId={productId}
      productUrl={productUrl}
      onDelete={onDelete}
      onReply={onReply}
      onEdit={onEdit}
      onStatusChange={onStatusChange}
      surface="row"
    />
  </div>
));
ReviewTableRow.displayName = "ReviewTableRow";

const ReviewsPage = () => {
  const queryClient = useQueryClient();
  const storeDomain = getStoreDomain();
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const [searchParams, setSearchParams] = useSearchParams();
  const [starFilter, setStarFilter] = useState(null);
  const [activeTab, setActiveTab] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModalProductId, setCreateModalProductId] = useState(null);
  const [viewMode, setViewMode] = useState("list");
  const [page, setPage] = useState(1);
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [selectedProduct, setSelectedProduct] = useState(
    searchParams.get("product") || null,
  );
  const [selectedProductSnapshot, setSelectedProductSnapshot] = useState(null);

  const { data: productsData } = useQuery({
    queryKey: shopQueryKeys.products(storeDomain, { limit: 50 }),
    queryFn: () => fetchProducts({ limit: 50 }),
    staleTime: 5 * 60 * 1000,
    enabled: !!storeDomain,
  });

  const { data: searchedProductsData } = useQuery({
    queryKey: shopQueryKeys.products(storeDomain, {
      limit: 50,
      title: productSearchQuery,
    }),
    queryFn: () => fetchProducts({ limit: 50, title: productSearchQuery }),
    staleTime: 60 * 1000,
    enabled: !!storeDomain && productSearchQuery.length >= 2,
  });

  const { data: overview } = useQuery({
    queryKey: shopQueryKeys.dashboardOverview(storeDomain),
    queryFn: fetchDashboardOverview,
    staleTime: 5 * 60 * 1000,
    enabled: !!storeDomain,
  });

  const statsMap = useMemo(() => {
    const map = new Map();
    (overview?.productStats || []).forEach((productStat) => {
      if (productStat.reviewCount > 0) {
        map.set(String(productStat.productId), productStat);
      }
    });
    return map;
  }, [overview]);

  const products = useMemo(() => {
    const map = new Map();
    const addProduct = (product) => {
      if (!product?.id) return;
      const key = String(product.id);
      const current = map.get(key) || {};
      map.set(key, {
        ...product,
        ...current,
        title: current.title || product.title,
        handle: current.handle || product.handle,
        image: current.image || product.image,
        images: current.images || product.images,
        featured_image: current.featured_image || product.featured_image,
      });
    };

    (productsData?.products || []).forEach(addProduct);
    (searchedProductsData?.products || []).forEach(addProduct);
    (overview?.productStats || []).forEach((productStat) => {
      addProduct({
        id: productStat.productId,
        title: !isGenericProductLabel(productStat.title, productStat.productId)
          ? productStat.title || "Không rõ sản phẩm"
          : "Không rõ sản phẩm",
        image: typeof productStat.image === "string"
          ? { src: productStat.image }
          : productStat.image,
      });
    });

    return Array.from(map.values());
  }, [overview, productsData, searchedProductsData]);

  const productInList = useMemo(
    () =>
      products.find(
        (product) => String(product.id) === String(selectedProduct || ""),
      ) || null,
    [products, selectedProduct],
  );

  const { data: selectedProductDetails } = useQuery({
    queryKey: shopQueryKeys.product(storeDomain, selectedProduct),
    queryFn: () => fetchProduct(selectedProduct),
    enabled: !!storeDomain && !!selectedProduct && !productInList,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!selectedProduct) {
      setSelectedProductSnapshot(null);
      return;
    }
    if (productInList) {
      setSelectedProductSnapshot(productInList);
      return;
    }
    if (selectedProductDetails) {
      setSelectedProductSnapshot(selectedProductDetails);
    }
  }, [productInList, selectedProduct, selectedProductDetails]);

  const selectedProductInfo =
    productInList || selectedProductDetails || selectedProductSnapshot;

  const reviewPageTitle = selectedProductInfo?.title
    ? `Đánh giá của sản phẩm: ${selectedProductInfo.title}`
    : "Tất cả đánh giá";

  const selectedProductLiveUrl =
    buildProductUrl(storeDomain, selectedProductInfo?.handle) || null;

  const handleProductChange = useCallback((value, product = null) => {
    if (product) setSelectedProductSnapshot(product);
    if (!value) setSelectedProductSnapshot(null);
    setSelectedProduct(value);
    setStarFilter(null);
    setActiveTab("all");
    setPage(1);
    const nextParams = storeDomain ? { storeDomain } : {};
    if (value) nextParams.product = value;
    setSearchParams(nextParams, { replace: true });
  }, [storeDomain, setSearchParams]);

  const handleOpenCreateModal = useCallback(() => {
    setCreateModalProductId(selectedProduct || null);
    setShowCreateModal(true);
  }, [selectedProduct]);

  const { data: productReviews = [], isLoading: productReviewsLoading } = useQuery({
    queryKey: shopQueryKeys.reviews(storeDomain, selectedProduct),
    queryFn: () => fetchReviews(selectedProduct),
    enabled: !!selectedProduct,
    staleTime: 5 * 60 * 1000,
  });

  const allReviewsParams = useMemo(
    () => ({
      page,
      pageSize: ALL_REVIEWS_PAGE_SIZE,
      sortBy,
      status: activeTab,
      ...(starFilter ? { star: starFilter } : {}),
    }),
    [activeTab, page, sortBy, starFilter],
  );

  const { data: allReviewsData, isLoading: allReviewsLoading } = useQuery({
    queryKey: shopQueryKeys.allReviews(storeDomain, allReviewsParams),
    queryFn: () => fetchAllReviews(allReviewsParams),
    enabled: !selectedProduct && !!storeDomain,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const reviews = selectedProduct ? productReviews : allReviewsData?.items || [];
  const reviewsLoading = selectedProduct
    ? productReviewsLoading
    : allReviewsLoading;

  const searchableProducts = useMemo(() => {
    const map = new Map();
    const addProduct = (product) => {
      if (!product?.id) return;
      const key = String(product.id);
      const current = map.get(key) || {};
      map.set(key, {
        ...product,
        ...current,
        title:
          current.title ||
          (!isGenericProductLabel(product.title, product.id) ? product.title : "") ||
          product.productName ||
          product.productTitle ||
          "Không rõ sản phẩm",
        handle: current.handle || product.handle || product.productHandle,
        image: current.image || product.image || product.productImage,
        images: current.images || product.images,
        featured_image: current.featured_image || product.featured_image,
      });
    };

    products.forEach(addProduct);
    reviews.forEach((review) => {
      addProduct({
        id: review.productId,
        title:
          (!isGenericProductLabel(review.productName, review.productId) ? review.productName : "") ||
          (!isGenericProductLabel(review.productTitle, review.productId) ? review.productTitle : "") ||
          "Không rõ sản phẩm",
        handle: review.productHandle,
        image: review.productImage,
      });
    });

    return Array.from(map.values());
  }, [products, reviews]);

  const productLookup = useMemo(() => {
    const map = new Map();
    searchableProducts.forEach((product) => {
      if (product?.id) map.set(String(product.id), product);
    });
    return map;
  }, [searchableProducts]);

  const enrichReviewProduct = useCallback((review) => {
    const id = review.productId || selectedProduct;
    const product = id ? productLookup.get(String(id)) : null;
    if (!product) return review;

    const currentTitle = review.productTitle || review.productName || "";
    const productTitle =
      currentTitle && !isGenericProductLabel(currentTitle, id)
        ? currentTitle
        : product.title || product.productTitle || product.productName || currentTitle;

    return {
      ...review,
      productId: review.productId || id,
      productTitle,
      productName:
        review.productName && !isGenericProductLabel(review.productName, id)
          ? review.productName
          : product.productName || product.title || productTitle,
      productHandle: review.productHandle || product.handle || product.productHandle,
      productImage:
        review.productImage ||
        product.image ||
        product.productImage ||
        product.featured_image ||
        product.images?.[0],
    };
  }, [productLookup, selectedProduct]);

  const { data: summary } = useQuery({
    queryKey: shopQueryKeys.reviewSummary(storeDomain, selectedProduct),
    queryFn: () => fetchReviewSummary(selectedProduct),
    enabled: !!selectedProduct,
    staleTime: 5 * 60 * 1000,
  });

  const localStatusCounts = useMemo(() => {
    const counts = {
      all: 0,
      approved: 0,
      pending: 0,
      hidden: 0,
      spam: 0,
      unreplied: 0,
    };
    reviews.forEach((review) => {
      counts.all += 1;
      const status = review.status || "approved";
      if (counts[status] !== undefined) counts[status] += 1;
      if (!review.reply) counts.unreplied += 1;
    });
    return counts;
  }, [reviews]);

  const filteredReviews = useMemo(() => {
    if (!selectedProduct) return reviews;
    let result = [...reviews];

    if (activeTab === "unreplied") {
      result = result.filter((review) => !review.reply);
    } else if (activeTab !== "all") {
      result = result.filter(
        (review) => (review.status || "approved") === activeTab,
      );
    }

    if (starFilter) {
      result = result.filter((review) => review.rating === starFilter);
    }

    if (sortBy === "newest") {
      result.sort((left, right) => right.created_at - left.created_at);
    } else if (sortBy === "oldest") {
      result.sort((left, right) => left.created_at - right.created_at);
    }

    return result;
  }, [reviews, selectedProduct, starFilter, sortBy, activeTab]);

  const visibleReviews = useMemo(() => {
    const rows = !selectedProduct
      ? filteredReviews
      : (() => {
          const start = (page - 1) * ALL_REVIEWS_PAGE_SIZE;
          return filteredReviews.slice(start, start + ALL_REVIEWS_PAGE_SIZE);
        })();
    return rows.map(enrichReviewProduct);
  }, [enrichReviewProduct, filteredReviews, page, selectedProduct]);

  const visibleReviewCount = useMemo(() => {
    if (!selectedProduct) return filteredReviews.length;
    const start = (page - 1) * ALL_REVIEWS_PAGE_SIZE;
    return filteredReviews.slice(start, start + ALL_REVIEWS_PAGE_SIZE).length;
  }, [filteredReviews, page, selectedProduct]);

  const statusCounts = selectedProduct
    ? localStatusCounts
    : allReviewsData?.statusCounts || EMPTY_STATUS_COUNTS;

  const allReviewsPagination = selectedProduct
    ? {
        total: filteredReviews.length,
        page,
        pageSize: ALL_REVIEWS_PAGE_SIZE,
        totalPages: Math.max(1, Math.ceil(filteredReviews.length / ALL_REVIEWS_PAGE_SIZE)),
      }
    : {
        total: allReviewsData?.total || 0,
        page: allReviewsData?.page || page,
        pageSize: allReviewsData?.pageSize || ALL_REVIEWS_PAGE_SIZE,
        totalPages: allReviewsData?.totalPages || 1,
      };

  useEffect(() => {
    if (selectedProduct || !allReviewsData?.page) return;
    if (allReviewsData.page !== page) {
      setPage(allReviewsData.page);
    }
  }, [allReviewsData?.page, page, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct) return;
    const totalPages = Math.max(1, Math.ceil(filteredReviews.length / ALL_REVIEWS_PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [filteredReviews.length, page, selectedProduct]);

  const invalidateAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: shopQueryKeys.reviews(storeDomain, selectedProduct),
      }),
      queryClient.invalidateQueries({
        queryKey: shopQueryKeys.allReviewsRoot(storeDomain),
      }),
      queryClient.invalidateQueries({
        queryKey: shopQueryKeys.reviewSummary(storeDomain, selectedProduct),
      }),
      queryClient.invalidateQueries({
        queryKey: shopQueryKeys.dashboardOverview(storeDomain),
      }),
    ]);
  }, [storeDomain, queryClient, selectedProduct]);

  const getProductId = useCallback((review) => review.productId || selectedProduct, [selectedProduct]);

  const patchReviewCaches = useCallback((productId, reviewId, updater) => {
    if (productId) {
      queryClient.setQueryData(shopQueryKeys.reviews(storeDomain, productId), (current) =>
        Array.isArray(current)
          ? current.map((review) => (review.id === reviewId ? updater(review) : review))
          : current,
      );
    }
    queryClient.setQueryData(shopQueryKeys.allReviews(storeDomain, allReviewsParams), (current) =>
      current?.items
        ? {
            ...current,
            items: current.items.map((review) =>
              review.id === reviewId && String(review.productId || productId) === String(productId)
                ? updater(review)
                : review,
            ),
          }
        : current,
    );
  }, [allReviewsParams, storeDomain, queryClient]);

  const removeReviewFromCaches = useCallback((productId, reviewId) => {
    if (productId) {
      queryClient.setQueryData(shopQueryKeys.reviews(storeDomain, productId), (current) =>
        Array.isArray(current) ? current.filter((review) => review.id !== reviewId) : current,
      );
    }
    queryClient.setQueryData(shopQueryKeys.allReviews(storeDomain, allReviewsParams), (current) =>
      current?.items
        ? {
            ...current,
            items: current.items.filter(
              (review) =>
                !(review.id === reviewId && String(review.productId || productId) === String(productId)),
            ),
            total: Math.max(0, Number(current.total || 0) - 1),
          }
        : current,
    );
  }, [allReviewsParams, storeDomain, queryClient]);

  const getProductUrl = useCallback(
    (review) =>
      buildProductUrl(storeDomain, review.productHandle || selectedProductInfo?.handle) || null,
    [selectedProductInfo?.handle, storeDomain],
  );

  const handleDelete = useCallback(async (reviewId, review) => {
    const productId = getProductId(review);
    removeReviewFromCaches(productId, reviewId);
    try {
      await deleteReview(productId, reviewId);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getProductId, invalidateAll, removeReviewFromCaches]);

  const handleReply = useCallback(async (reviewId, data, review) => {
    const productId = getProductId(review);
    patchReviewCaches(productId, reviewId, (item) => ({
      ...item,
      reply: data.reply,
      replied_at: Date.now(),
    }));
    try {
      await replyToReview(productId, reviewId, data);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getProductId, invalidateAll, patchReviewCaches]);

  const handleEdit = useCallback(async (reviewId, data, review) => {
    const productId = getProductId(review);
    patchReviewCaches(productId, reviewId, (item) => ({ ...item, ...data }));
    try {
      await updateReview(productId, reviewId, data);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getProductId, invalidateAll, patchReviewCaches]);

  const handleStatusChange = useCallback(async (reviewId, status, review) => {
    const productId = getProductId(review);
    patchReviewCaches(productId, reviewId, (item) => ({ ...item, status }));
    try {
      await updateReviewStatus(productId, reviewId, status);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getProductId, invalidateAll, patchReviewCaches]);

  const reviewKey = useCallback(
    (review) => `${getProductId(review) || ""}:${review.id}`,
    [getProductId],
  );

  const toggleSelected = useCallback((review) => {
    const key = reviewKey(review);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [reviewKey]);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  useEffect(() => {
    clearSelection();
  }, [activeTab, page, starFilter, selectedProduct, clearSelection]);

  const selectedItems = useMemo(() => {
    const items = [];
    selectedKeys.forEach((key) => {
      const [productId, reviewId] = String(key).split(":");
      if (productId && reviewId) items.push({ productId, reviewId });
    });
    return items;
  }, [selectedKeys]);

  const runBulk = useCallback(async (action) => {
    if (!selectedItems.length) return;
    setBulkBusy(true);
    try {
      const result = await bulkReviews(action, selectedItems);
      toast.success(`Đã cập nhật ${result.updated} mục, đã xoá ${result.deleted ?? 0} mục, bỏ qua ${result.skipped} mục`);
      clearSelection();
      void invalidateAll();
    } catch (error) {
      toast.error(getErrorMessage(error, "Thao tác hàng loạt thất bại"));
    } finally {
      setBulkBusy(false);
    }
  }, [clearSelection, invalidateAll, selectedItems]);

  const handleExport = useCallback(async (format) => {
    setExporting(true);
    try {
      const payload = await exportReviews(format);
      downloadExport(payload, `danh-gia.${format}`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Xuất dữ liệu thất bại"));
    } finally {
      setExporting(false);
    }
  }, []);

  const tabItems = Object.entries(STATUS_CONFIG).map(([key, config]) => ({
    key,
    label: (
      <Flex align="center" gap={6}>
        <span>{config.label}</span>
        {statusCounts[key] > 0 && (
          <Badge
            count={statusCounts[key]}
            overflowCount={999999}
            size="small"
            style={{
              backgroundColor:
                key === "spam"
                  ? "#ff4d4f"
                  : key === "unreplied"
                    ? "#722ed1"
                    : key === "pending"
                      ? "#faad14"
                      : undefined,
              fontSize: 10,
              lineHeight: "16px",
              height: 16,
              minWidth: 16,
              padding: "0 4px",
            }}
          />
        )}
      </Flex>
    ),
  }));

  const actionButtonStyle = {
    borderRadius: 6,
    ...(isMobile ? { flex: "1 1 calc(50% - 4px)", minWidth: 0 } : {}),
  };

  return (
    <AdminLayout>
      <Breadcrumb
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: "Đánh giá" },
          { title: selectedProductInfo?.title || "Tất cả đánh giá" },
        ]}
        style={{ marginBottom: 16 }}
      />

      <Flex
        justify="space-between"
        align={isMobile ? "stretch" : "center"}
        gap={12}
        wrap
        style={{ marginBottom: 16 }}
      >
        <Title level={4} style={{ margin: 0 }}>
          {reviewPageTitle}
        </Title>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: isMobile ? "stretch" : "flex-end",
            width: isMobile ? "100%" : "auto",
          }}
        >
          {selectedProductLiveUrl && (
            <Button
              icon={<EyeOutlined />}
              href={selectedProductLiveUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={actionButtonStyle}
            >
              Xem trực tiếp
            </Button>
          )}
          <ExportMenu label="Xuất" onExport={handleExport} loading={exporting} />
          <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)} style={actionButtonStyle}>
            Nhập CSV/JSON
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleOpenCreateModal}
            title={!selectedProduct ? "Chọn sản phẩm để tạo đánh giá" : undefined}
            style={{
              ...actionButtonStyle,
              ...(isMobile ? { flexBasis: selectedProductLiveUrl ? "calc(50% - 4px)" : "100%" } : {}),
            }}
          >
            Tạo đánh giá mới
          </Button>
        </div>
      </Flex>

      {selectedProduct && summary && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={24} sm={8}>
            <StatCard
              icon={<CommentOutlined />}
              iconBg="linear-gradient(135deg, #1677ff, #0958d9)"
              label="Tổng đánh giá"
              value={summary.count || 0}
            />
          </Col>
          <Col xs={24} sm={8}>
            <StatCard
              icon={<StarFilled />}
              iconBg="linear-gradient(135deg, #fa8c16, #d46b08)"
              label="Trung bình"
              value={summary.avg || 0}
              suffix="sao"
            />
          </Col>
          <Col xs={24} sm={8}>
            <StatCard
              icon={<MessageOutlined />}
              iconBg="linear-gradient(135deg, #722ed1, #531dab)"
              label="Chưa phản hồi"
              value={statusCounts.unreplied}
            />
          </Col>
        </Row>
      )}

      <Flex
        align={isMobile ? "stretch" : "center"}
        gap={10}
        wrap={!isMobile}
        style={{
          marginBottom: 16,
          padding: "6px 10px",
          background: "#fafafa",
          borderRadius: 8,
          border: "1px solid #f0f0f0",
          flexDirection: isMobile ? "column" : "row",
        }}
      >
        {selectedProduct ? (
          <Button
            onClick={() => handleProductChange(null)}
            style={{ borderRadius: 6, flexShrink: 0 }}
          >
            Tất cả sản phẩm
          </Button>
        ) : null}

        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <ProductSearch
            products={searchableProducts}
            statsMap={statsMap}
            value={selectedProduct}
            onChange={handleProductChange}
            onQueryChange={setProductSearchQuery}
            placeholder={selectedProduct ? "Chọn sản phẩm khác…" : "Lọc theo sản phẩm…"}
          />
        </div>

        <div
          style={{
            width: 1,
            height: 24,
            background: "#e0e0e0",
            flexShrink: 0,
            display: isMobile ? "none" : "block",
          }}
        />

        <Space
          size={2}
          style={{
            flexShrink: 0,
            overflowX: isMobile ? "auto" : undefined,
            paddingBottom: isMobile ? 2 : 0,
            width: isMobile ? "100%" : undefined,
          }}
        >
          {STAR_FILTERS.map((star) => (
            <Button
              key={star}
              size="small"
              type={starFilter === star ? "primary" : "text"}
              onClick={() => {
                setStarFilter(starFilter === star ? null : star);
                setPage(1);
              }}
              style={{
                height: 30,
                padding: "0 8px",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 13,
                borderRadius: 6,
                fontWeight: 500,
              }}
            >
              <StarFilled
                style={{
                  color: starFilter === star ? "#fff" : "#faad14",
                  fontSize: 12,
                }}
              />
              {star}
            </Button>
          ))}
        </Space>

        <div
          style={{
            width: 1,
            height: 24,
            background: "#e0e0e0",
            flexShrink: 0,
            display: isMobile ? "none" : "block",
          }}
        />

        <Flex
          align="center"
          justify={isMobile ? "space-between" : "flex-start"}
          gap={8}
          style={{ width: isMobile ? "100%" : "auto", flexShrink: 0 }}
        >
          <Select
            value={sortBy}
            onChange={(value) => {
              setSortBy(value);
              setPage(1);
            }}
            variant="borderless"
            options={[
              { value: "newest", label: "Mới nhất" },
              { value: "oldest", label: "Cũ nhất" },
            ]}
            style={{ minWidth: 100, flexShrink: 0 }}
            size="small"
          />

          {!isMobile && (
            <div
              style={{
                width: 1,
                height: 24,
                background: "#e0e0e0",
                flexShrink: 0,
              }}
            />
          )}

          <Segmented
            value={viewMode}
            onChange={setViewMode}
            size="small"
            options={[
              { value: "list", icon: <UnorderedListOutlined /> },
              { value: "grid", icon: <AppstoreOutlined /> },
            ]}
          />
        </Flex>
      </Flex>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => {
          setActiveTab(key);
          setStarFilter(null);
          setPage(1);
        }}
        items={tabItems}
        tabBarGutter={12}
        more={{ icon: <span aria-hidden="true">…</span> }}
      />

      {selectedProduct && summary && (
        <div style={{ marginBottom: 20 }}>
          <RatingSummary summary={summary} />
        </div>
      )}

      <BulkActionBar
        count={selectedKeys.size}
        onClear={clearSelection}
        busy={bulkBusy}
        actions={[
          { key: "approve", label: "Duyệt", onClick: () => void runBulk("approve") },
          { key: "pending", label: "Chờ duyệt", onClick: () => void runBulk("pending") },
          { key: "hidden", label: "Ẩn", onClick: () => void runBulk("hidden") },
          { key: "spam", label: "Spam", onClick: () => void runBulk("spam") },
          {
            key: "delete",
            label: "Xoá",
            danger: true,
            confirm: `Xoá vĩnh viễn ${selectedItems.length} đánh giá?`,
            onClick: () => void runBulk("delete"),
          },
        ]}
      />

      <div style={{ minHeight: 200 }}>
        {reviewsLoading ? (
          <Flex justify="center" style={{ padding: "60px 0" }}>
            <Spin />
          </Flex>
        ) : filteredReviews.length === 0 ? (
          (statusCounts.all || 0) === 0 && !selectedProduct ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Chưa có đánh giá nào trên shop"
            >
              <Space wrap>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreateModal}>
                  Tạo đánh giá đầu tiên
                </Button>
                <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                  Nhập từ CSV/JSON
                </Button>
                <Button href="/dev" target="_blank" rel="noopener noreferrer">
                  Gắn widget vào theme
                </Button>
              </Space>
            </Empty>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Không có đánh giá khớp bộ lọc hiện tại"
            >
              <Button
                onClick={() => {
                  setStarFilter(null);
                  setActiveTab("all");
                  setProductSearchQuery("");
                  if (!selectedProduct) handleProductChange(null);
                  setPage(1);
                }}
              >
                Xoá bộ lọc
              </Button>
            </Empty>
          )
        ) : (
          <div className="f1g-bulk-table">
            <div className="f1g-bulk-table__head">
              <Flex align="center" gap={12} style={{ minWidth: 0 }}>
                {viewMode === "list" ? (
                  <Checkbox
                    aria-label="Chọn tất cả đánh giá trên trang"
                    checked={visibleReviews.length > 0 && visibleReviews.every((review) => selectedKeys.has(reviewKey(review)))}
                    indeterminate={visibleReviews.some((review) => selectedKeys.has(reviewKey(review))) && !visibleReviews.every((review) => selectedKeys.has(reviewKey(review)))}
                    onChange={(event) => {
                      setSelectedKeys((prev) => {
                        const next = new Set(prev);
                        visibleReviews.forEach((review) => {
                          if (event.target.checked) next.add(reviewKey(review));
                          else next.delete(reviewKey(review));
                        });
                        return next;
                      });
                    }}
                  />
                ) : null}
                <Text strong>Đánh giá</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {visibleReviewCount} mục đang hiển thị
                </Text>
              </Flex>
            </div>

            {viewMode === "grid" ? (
              <div className="f1g-bulk-table__grid">
                <Row gutter={[12, 12]}>
                  {visibleReviews.map((review) => (
                    <ReviewGridCell
                      key={review.id}
                      review={review}
                      productId={getProductId(review)}
                      productUrl={getProductUrl(review)}
                      onDelete={handleDelete}
                      onReply={handleReply}
                      onEdit={handleEdit}
                      onStatusChange={handleStatusChange}
                      selected={selectedKeys.has(reviewKey(review))}
                      onToggleSelect={() => toggleSelected(review)}
                    />
                  ))}
                </Row>
              </div>
            ) : (
              <div>
                {visibleReviews.map((review) => (
                  <ReviewTableRow
                    key={review.id}
                    review={review}
                    productId={getProductId(review)}
                    productUrl={getProductUrl(review)}
                    onDelete={handleDelete}
                    onReply={handleReply}
                    onEdit={handleEdit}
                    onStatusChange={handleStatusChange}
                    selected={selectedKeys.has(reviewKey(review))}
                    onToggleSelect={() => toggleSelected(review)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {allReviewsPagination &&
        allReviewsPagination.total > allReviewsPagination.pageSize && (
          <Flex justify="end" style={{ marginTop: 16 }}>
            <Pagination
              current={allReviewsPagination.page}
              pageSize={allReviewsPagination.pageSize}
              total={allReviewsPagination.total}
              showSizeChanger={false}
              onChange={(nextPage) => setPage(nextPage)}
            />
          </Flex>
        )}

      <Modal
        title="Tạo đánh giá mới"
        open={showCreateModal}
        onCancel={() => {
          setShowCreateModal(false);
          setCreateModalProductId(null);
        }}
        footer={null}
        width={1040}
        styles={{ body: { maxHeight: "calc(100vh - 180px)", overflowY: "auto" } }}
        destroyOnHidden
      >
        <ReviewForm
          products={products}
          initialProductId={createModalProductId}
          onSuccess={() => {
            setShowCreateModal(false);
            setCreateModalProductId(null);
          }}
        />
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        importFn={importReviews}
        subjectLabel="đánh giá"
        onImported={() => {
          clearSelection();
          void invalidateAll();
        }}
      />
    </AdminLayout>
  );
};

export default ReviewsPage;
