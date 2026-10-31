import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAllQuestions,
  fetchProduct,
  fetchProducts,
  fetchQuestions,
  createQuestion,
  answerQuestion,
  updateQuestionStatus,
  updateQuestion,
  deleteQuestion,
  fetchDashboardOverview,
} from "../../common/ApiService";
import { getStoreDomain } from "../../common/AuthStorage";
import { shopQueryKeys } from "../../common/queryKeys";
import AdminLayout from "../../components/layout/AdminLayout";
import { buildProductUrl } from "../../common/storeUrl";
import QnaCard from "../../components/qna/QnaCard";
import ProductSearch from "../../components/ProductSearch";
import { getErrorMessage } from "../../common/getErrorMessage";
import { toast } from "../../common/toast";
import {
  Spin, Select, Tabs, Button, Empty, Modal, Form, Input,
  Breadcrumb, Typography, Flex, Badge, Pagination, Grid,
} from "antd";
import { PlusOutlined, HomeOutlined } from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import Link from "../../components/StoreLink";

const { Title, Text } = Typography;
const { TextArea } = Input;
const { useBreakpoint } = Grid;
const EMAIL_RE = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const ALL_QNA_PAGE_SIZE = 20;
const EMPTY_STATUS_COUNTS = {
  all: 0,
  pending: 0,
  unanswered: 0,
  answered: 0,
  hidden: 0,
};

const STATUS_CONFIG = {
  all: { label: "Tất cả" },
  pending: { label: "Chờ duyệt", color: "warning" },
  unanswered: { label: "Chưa trả lời", color: "purple" },
  answered: { label: "Đã trả lời", color: "success" },
  hidden: { label: "Đã ẩn", color: "default" },
};

const isGenericProductLabel = (value, productId) =>
  Boolean(productId && String(value || "").trim() === `Sản phẩm #${productId}`);

const QuestionTableRow = memo(({
  question,
  productUrl,
  onAnswer,
  onStatusChange,
  onDelete,
  onEdit,
}) => {
  const handleAnswer = useCallback(
    (questionId, data) => onAnswer(questionId, data, question),
    [onAnswer, question],
  );
  const handleStatusChange = useCallback(
    (questionId, data) => onStatusChange(questionId, data, question),
    [onStatusChange, question],
  );
  const handleDelete = useCallback(
    (questionId) => onDelete(questionId, question),
    [onDelete, question],
  );
  const handleEdit = useCallback(
    (questionId, data) => onEdit(questionId, data, question),
    [onEdit, question],
  );

  return (
    <div className="f1g-bulk-table__row">
      <QnaCard
        question={question}
        onAnswer={handleAnswer}
        onStatusChange={handleStatusChange}
        onDelete={handleDelete}
        onEdit={handleEdit}
        productUrl={productUrl}
      />
    </div>
  );
});
QuestionTableRow.displayName = "QuestionTableRow";

const QnaPage = () => {
  const queryClient = useQueryClient();
  const storeDomain = getStoreDomain();
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [page, setPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState(searchParams.get("product") || null);
  const [selectedProductSnapshot, setSelectedProductSnapshot] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const [productSearchQuery, setProductSearchQuery] = useState("");

  const { data: overview } = useQuery({
    queryKey: shopQueryKeys.dashboardOverview(storeDomain),
    queryFn: fetchDashboardOverview,
    staleTime: 5 * 60 * 1000,
    enabled: !!storeDomain,
  });

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

  const statsMap = useMemo(() => {
    const map = new Map();
    (overview?.productStats || []).forEach((productStat) => {
      if (productStat.qnaTotal > 0) {
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
    () => products.find((product) => String(product.id) === String(selectedProduct || "")) || null,
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

  const qnaPageTitle = selectedProductInfo?.title
    ? `Hỏi đáp của sản phẩm: ${selectedProductInfo.title}`
    : "Tất cả câu hỏi";

  const handleProductChange = useCallback((value, product = null) => {
    if (product) setSelectedProductSnapshot(product);
    if (!value) setSelectedProductSnapshot(null);
    setSelectedProduct(value);
    setActiveTab("all");
    setPage(1);
    const nextParams = storeDomain ? { storeDomain } : {};
    if (value) nextParams.product = value;
    setSearchParams(nextParams, { replace: true });
  }, [storeDomain, setSearchParams]);

  const questionsParams = useMemo(
    () => ({
      page,
      pageSize: ALL_QNA_PAGE_SIZE,
      sortBy,
      status: activeTab,
    }),
    [activeTab, page, sortBy],
  );

  const {
    data: productQuestionsData,
    isLoading: productQuestionsLoading,
    isPlaceholderData: productQuestionsPlaceholder,
  } = useQuery({
    queryKey: shopQueryKeys.productQna(storeDomain, selectedProduct, questionsParams),
    queryFn: () => fetchQuestions(selectedProduct, questionsParams),
    enabled: !!selectedProduct && !!storeDomain,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const {
    data: allQuestionsData,
    isLoading: allQuestionsLoading,
    isPlaceholderData: allQuestionsPlaceholder,
  } = useQuery({
    queryKey: shopQueryKeys.allQna(storeDomain, questionsParams),
    queryFn: () => fetchAllQuestions(questionsParams),
    enabled: !selectedProduct && !!storeDomain,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const questionsData = selectedProduct ? productQuestionsData : allQuestionsData;
  const questionsLoading = selectedProduct ? productQuestionsLoading : allQuestionsLoading;
  const questionsPlaceholder = selectedProduct ? productQuestionsPlaceholder : allQuestionsPlaceholder;
  const visibleQuestions = questionsData?.items || [];

  const qnaPagination = {
    total: questionsData?.total || 0,
    page: questionsData?.page || page,
    pageSize: questionsData?.pageSize || ALL_QNA_PAGE_SIZE,
  };

  useEffect(() => {
    if (questionsPlaceholder || !questionsData?.page) return;
    if (questionsData.page !== page) setPage(questionsData.page);
  }, [questionsData?.page, questionsPlaceholder, page]);

  const invalidateAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: shopQueryKeys.qnaRoot(storeDomain) }),
      queryClient.invalidateQueries({ queryKey: shopQueryKeys.dashboardOverview(storeDomain) }),
    ]);
  }, [storeDomain, queryClient]);

  const getQuestionProductId = useCallback(
    (question) => selectedProduct || question?.productId,
    [selectedProduct],
  );
  const patchQuestionCaches = useCallback((productId, questionId, updater) => {
    queryClient.setQueriesData({ queryKey: shopQueryKeys.qnaRoot(storeDomain) }, (current) =>
      current?.items
        ? {
            ...current,
            items: current.items.map((question) =>
              question.id === questionId && String(question.productId || productId) === String(productId)
                ? updater(question)
                : question,
            ),
          }
        : current,
    );
  }, [storeDomain, queryClient]);

  const removeQuestionFromCaches = useCallback((productId, questionId) => {
    queryClient.setQueriesData({ queryKey: shopQueryKeys.qnaRoot(storeDomain) }, (current) =>
      current?.items
        ? {
            ...current,
            items: current.items.filter(
              (question) =>
                !(question.id === questionId && String(question.productId || productId) === String(productId)),
            ),
            total: Math.max(0, Number(current.total || 0) - 1),
          }
        : current,
    );
  }, [storeDomain, queryClient]);

  const getQuestionProductUrl = useCallback(
    (question) => buildProductUrl(storeDomain, question?.productHandle || selectedProductInfo?.handle),
    [selectedProductInfo?.handle, storeDomain],
  );

  const handleAnswer = useCallback(async (questionId, data, question) => {
    const productId = getQuestionProductId(question);
    patchQuestionCaches(productId, questionId, (item) => ({
      ...item,
      answer: data.answer,
      answered_at: Date.now(),
    }));
    try {
      await answerQuestion(productId, questionId, data);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getQuestionProductId, invalidateAll, patchQuestionCaches]);

  const handleStatusChange = useCallback(async (questionId, data, question) => {
    const productId = getQuestionProductId(question);
    patchQuestionCaches(productId, questionId, (item) => ({ ...item, ...data }));
    try {
      await updateQuestionStatus(productId, questionId, data);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getQuestionProductId, invalidateAll, patchQuestionCaches]);

  const handleDelete = useCallback(async (questionId, question) => {
    const productId = getQuestionProductId(question);
    removeQuestionFromCaches(productId, questionId);
    try {
      await deleteQuestion(productId, questionId);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getQuestionProductId, invalidateAll, removeQuestionFromCaches]);

  const handleEdit = useCallback(async (questionId, data, question) => {
    const productId = getQuestionProductId(question);
    patchQuestionCaches(productId, questionId, (item) => ({ ...item, ...data }));
    try {
      await updateQuestion(productId, questionId, data);
      void invalidateAll();
    } catch (error) {
      void invalidateAll();
      throw error;
    }
  }, [getQuestionProductId, invalidateAll, patchQuestionCaches]);

  const handleCreate = async (values) => {
    setCreating(true);
    try {
      await createQuestion(selectedProduct, values);
      toast.success("Đã tạo câu hỏi");
      setShowCreateModal(false);
      form.resetFields();
      await invalidateAll();
    } catch (error) {
      toast.error(getErrorMessage(error, "Tạo câu hỏi thất bại"));
    } finally {
      setCreating(false);
    }
  };

  const statusCounts = questionsData?.statusCounts || EMPTY_STATUS_COUNTS;

  const tabItems = Object.entries(STATUS_CONFIG).map(([key, config]) => ({
    key,
    label: (
      <Flex align="center" gap={6}>
        <span>{config.label}</span>
        {statusCounts[key] > 0 ? (
          <Badge
            count={statusCounts[key]}
            overflowCount={999999}
            size="small"
            style={{
              backgroundColor: key === "pending" ? "#faad14" : key === "unanswered" ? "#722ed1" : undefined,
              fontSize: 10,
              lineHeight: "16px",
              height: 16,
              minWidth: 16,
              padding: "0 4px",
            }}
          />
        ) : null}
      </Flex>
    ),
  }));

  const actionButtonStyle = {
    ...(isMobile ? { flex: "1 1 calc(50% - 4px)", minWidth: 0 } : {}),
  };

  return (
    <AdminLayout>
      <Breadcrumb
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: "Hỏi đáp" },
          { title: selectedProductInfo?.title || "Tất cả câu hỏi" },
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
        <Title level={4} style={{ margin: 0 }}>{qnaPageTitle}</Title>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: isMobile ? "stretch" : "flex-end",
            width: isMobile ? "100%" : "auto",
          }}
        >
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setShowCreateModal(true)}
            disabled={!selectedProduct}
            style={{
              borderRadius: 6,
              ...actionButtonStyle,
              ...(isMobile ? { flexBasis: "100%" } : {}),
            }}
          >
            Tạo câu hỏi
          </Button>
        </div>
      </Flex>

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

        <div style={{ flex: 1, minWidth: 0 }}>
          <ProductSearch
            products={products}
            statsMap={statsMap}
            value={selectedProduct}
            onChange={handleProductChange}
            onQueryChange={setProductSearchQuery}
            placeholder={selectedProduct ? "Chọn sản phẩm khác…" : "Lọc theo sản phẩm…"}
            statsRenderer={(stats) => `${stats.qnaTotal} câu hỏi · ${Math.max(0, stats.qnaTotal - (stats.qnaUnanswered || 0))} đã trả lời`}
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
          style={{ minWidth: 100, flexShrink: 0, width: isMobile ? "100%" : undefined }}
          size="small"
        />
      </Flex>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => {
          setActiveTab(key);
          setPage(1);
        }}
        items={tabItems}
      />

      <div style={{ minHeight: 200 }}>
        {questionsLoading ? (
          <Flex justify="center" style={{ padding: "60px 0" }}>
            <Spin />
          </Flex>
        ) : visibleQuestions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có câu hỏi nào" />
        ) : (
          <div className="f1g-bulk-table">
            <div className="f1g-bulk-table__head">
              <Flex align="center" gap={12} style={{ minWidth: 0 }}>
                <Text strong>Câu hỏi</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {visibleQuestions.length} mục đang hiển thị
                </Text>
              </Flex>
            </div>

            <div>
              {visibleQuestions.map((question) => (
                <QuestionTableRow
                  key={question.id}
                  question={question}
                  productUrl={getQuestionProductUrl(question)}
                  onAnswer={handleAnswer}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                  onEdit={handleEdit}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {qnaPagination && qnaPagination.total > qnaPagination.pageSize ? (
        <Flex justify="end" style={{ marginTop: 16 }}>
          <Pagination
            current={qnaPagination.page}
            pageSize={qnaPagination.pageSize}
            total={qnaPagination.total}
            showSizeChanger={false}
            onChange={(nextPage) => setPage(nextPage)}
          />
        </Flex>
      ) : null}

      <Modal
        title="Tạo câu hỏi mới"
        open={showCreateModal}
        onCancel={() => {
          setShowCreateModal(false);
          form.resetFields();
        }}
        footer={null}
        width={500}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleCreate} style={{ marginTop: 16 }}>
          <Form.Item
            name="author"
            label="Tên người hỏi"
            rules={[{ required: true, message: "Nhập tên" }]}
          >
            <Input maxLength={100} placeholder="Nguyễn Văn A" />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email (không bắt buộc)"
            rules={[
              {
                validator: async (_, value) => {
                  const email = typeof value === "string" ? value.trim() : "";
                  if (email && !EMAIL_RE.test(email)) throw new Error("Email không hợp lệ");
                },
              },
            ]}
          >
            <Input type="email" placeholder="email@example.com" />
          </Form.Item>
          <Form.Item
            name="question"
            label="Câu hỏi"
            rules={[{ required: true, message: "Nhập câu hỏi" }]}
          >
            <TextArea rows={3} maxLength={1000} showCount placeholder="Nhập câu hỏi…" />
          </Form.Item>
          <Flex justify="end" gap={8}>
            <Button
              onClick={() => {
                setShowCreateModal(false);
                form.resetFields();
              }}
            >
              Hủy
            </Button>
            <Button type="primary" htmlType="submit" loading={creating}>Tạo</Button>
          </Flex>
        </Form>
      </Modal>

    </AdminLayout>
  );
};

export default QnaPage;
