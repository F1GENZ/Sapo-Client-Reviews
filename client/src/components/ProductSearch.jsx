import { memo, useState, useMemo, useEffect, useRef, useCallback, useDeferredValue } from "react";
import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";

const MAX_VISIBLE_PRODUCTS = 40;

const getProductImage = (product) => {
  if (!product) return "";
  if (typeof product.image === "string") return product.image;
  if (product.image?.src) return product.image.src;
  if (Array.isArray(product.images) && product.images[0]?.src) return product.images[0].src;
  if (product.featured_image) return product.featured_image;
  return "";
};

const normalizeSearchText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const formatDefaultStats = (stats) => {
  const avg = Number(stats.avgRating ?? stats.reviewAvg);
  const count = Number(stats.reviewCount) || 0;
  return Number.isFinite(avg) ? `${count} đánh giá · ${avg.toFixed(1)} sao` : `${count} đánh giá`;
};

/**
 * Smart product search dropdown with keyboard navigation (WCAG 2.1 AA).
 * Reusable across Reviews and QnA pages.
 */
const ProductSearch = ({
  products = [],
  statsMap,
  value,
  onChange,
  placeholder,
  statsRenderer,
  onQueryChange,
}) => {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapperRef = useRef(null);
  const listRef = useRef(null);

  const selectedProduct = useMemo(
    () => products.find((p) => String(p.id) === String(value || "")),
    [products, value],
  );

  const productSearchIndex = useMemo(
    () => products.map((product) => ({
      product,
      searchText: [
        product.title,
        product.productName,
        product.productTitle,
        product.handle,
        product.productHandle,
        product.id,
      ].map(normalizeSearchText).join(" "),
    })),
    [products],
  );

  const filtered = useMemo(() => {
    const q = normalizeSearchText(deferredQuery);
    if (!q) return productSearchIndex.map((entry) => entry.product);

    const matches = [];
    for (const entry of productSearchIndex) {
      if (entry.searchText.includes(q)) matches.push(entry.product);
    }
    return matches;
  }, [productSearchIndex, deferredQuery]);

  useEffect(() => {
    if (!onQueryChange) return undefined;
    const timer = window.setTimeout(() => onQueryChange(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [onQueryChange, query]);

  const sorted = useMemo(() => {
    const source = statsMap ? [...filtered].sort((a, b) => {
      const sa = statsMap.get(String(a.id));
      const sb = statsMap.get(String(b.id));
      const ca = sa?.reviewCount || sa?.qnaTotal || 0;
      const cb = sb?.reviewCount || sb?.qnaTotal || 0;
      return cb - ca;
    }) : filtered;
    return source.slice(0, MAX_VISIBLE_PRODUCTS);
  }, [filtered, statsMap]);

  // Reset active index when list changes
  useEffect(() => { setActiveIdx(-1); }, [sorted]);

  // Close on outside click
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handler, { passive: true });
    return () => document.removeEventListener("pointerdown", handler);
  }, [open]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-product-item]");
    items[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const selectItem = useCallback((product) => {
    const nextValue = String(product.id) === String(value || "") ? null : String(product.id);
    onChange(nextValue, nextValue ? product : null);
    setOpen(false);
    setQuery("");
    setActiveIdx(-1);
  }, [onChange, value]);

  const handleKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((prev) => (prev < sorted.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((prev) => (prev > 0 ? prev - 1 : sorted.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIdx >= 0 && sorted[activeIdx]) selectItem(sorted[activeIdx]);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setActiveIdx(-1);
        break;
      default: break;
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative", width: "100%" }} role="combobox" aria-expanded={open} aria-haspopup="listbox">
      <Input
        prefix={<SearchOutlined style={{ color: "#bbb" }} />}
        placeholder={selectedProduct ? selectedProduct.title : (placeholder || "Tìm sản phẩm…")}
        value={open ? query : ""}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        allowClear
        onClear={() => { setQuery(""); onChange(null, null); }}
        size="middle"
        aria-label="Tìm kiếm sản phẩm"
        aria-autocomplete="list"
        style={{
          borderRadius: 6,
          ...(selectedProduct && !open ? { fontWeight: 600 } : {}),
        }}
      />
      {open && (
        <div
          ref={listRef}
          className="f1g-product-search-menu"
          role="listbox"
          aria-label="Danh sách sản phẩm"
        >
          {sorted.length === 0 ? (
            <div className="f1g-product-search-empty">
              Không tìm thấy sản phẩm
            </div>
          ) : (
            <>
              <div className="f1g-product-search-list">
                {sorted.map((p, idx) => {
                  const stats = statsMap?.get(String(p.id));
                  const isSelected = String(p.id) === value;
                  const isActive = idx === activeIdx;
                  const imageSrc = getProductImage(p);
                  return (
                    <button
                      key={String(p.id)}
                      type="button"
                      className={`f1g-product-search-item${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                      data-product-item
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => selectItem(p)}
                      onMouseEnter={() => setActiveIdx(idx)}
                    >
                      {imageSrc ? (
                        <img className="f1g-product-search-thumb" src={imageSrc} alt="" loading="lazy" width="44" height="44" />
                      ) : (
                        <span className="f1g-product-search-thumb f1g-product-search-thumb--empty" aria-hidden="true">
                          {String(p.title || p.id || "S").trim().slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="f1g-product-search-body">
                        <span className="f1g-product-search-title">{p.title}</span>
                        <span className="f1g-product-search-meta">
                          {stats
                            ? (statsRenderer ? statsRenderer(stats) : formatDefaultStats(stats))
                            : (statsRenderer ? "Chưa có dữ liệu" : "Chưa có đánh giá")}
                        </span>
                      </span>
                      {isSelected && <span className="f1g-product-search-tag">Đang chọn</span>}
                    </button>
                  );
                })}
              </div>
              {filtered.length > MAX_VISIBLE_PRODUCTS && (
                <div className="f1g-product-search-note">
                  Hiển thị {MAX_VISIBLE_PRODUCTS}/{filtered.length} sản phẩm. Nhập thêm từ khóa để lọc chính xác hơn.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default memo(ProductSearch);
