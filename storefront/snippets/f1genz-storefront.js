(() => {
  if (window.__f1genzSapoReviewStorefrontRuntimeBooted) return;
  window.__f1genzSapoReviewStorefrontRuntimeBooted = true;
  const ACCOUNT_LOGIN_URL = '/account';
  const MISSING_API_URL_MESSAGE =
    '[f1genz-storefront] No API URL found, so the widget sends no requests. Set window.__F1GENZ_STOREFRONT_CONFIG = { apiUrl: "https://<api-host>", storeDomain: "<store>.mysapo.net" } before the script tag, or load the script from the API host (https://<api-host>/storefront/f1genz-storefront.js).';

  function normalizeApiUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.origin;
    } catch {
      return '';
    }
  }

  function readRuntimeConfigObject() {
    const candidates = [
      window.__F1GENZ_STOREFRONT_CONFIG,
      window.F1GENZ_STOREFRONT_CONFIG,
      window.f1genzStorefrontConfig,
    ].filter(Boolean);

    return candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
  }

  function readRuntimeConfigFromWindow() {
    const candidates = [
      window.__F1GENZ_STOREFRONT_CONFIG,
      window.F1GENZ_STOREFRONT_CONFIG,
      window.f1genzStorefrontConfig,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') {
        const apiUrl = normalizeApiUrl(candidate.apiUrl);
        if (apiUrl) return apiUrl;
      }
    }

    return '';
  }

  function readRuntimeConfigFromScript() {
    const currentScript =
      document.currentScript instanceof HTMLScriptElement
        ? document.currentScript
        : null;
    const candidates = [
      currentScript,
      ...Array.from(document.querySelectorAll('script[src]')).filter((script) =>
        /\/storefront\/f1genz-storefront\.js(?:[?#].*)?$/i.test(
          script.getAttribute('src') || '',
        ),
      ),
    ].filter(Boolean);

    for (const script of candidates) {
      if (!(script instanceof HTMLScriptElement)) continue;
      const explicit = normalizeApiUrl(script.dataset.apiUrl || script.getAttribute('data-api-url'));
      if (explicit) return explicit;
      const srcOrigin = normalizeApiUrl(script.src);
      if (srcOrigin) return srcOrigin;
    }

    return '';
  }

  function resolveRuntimeApiUrl() {
    const resolved = readRuntimeConfigFromWindow() || readRuntimeConfigFromScript();
    if (resolved) return resolved;

    if (!window.__f1genzSapoReviewStorefrontRuntimeMissingApiWarned) {
      window.__f1genzSapoReviewStorefrontRuntimeMissingApiWarned = true;
      console.error(MISSING_API_URL_MESSAGE);
    }
    return '';
  }

  function normalizeCustomerPhone(value) {
    return String(value || '').replace(/[\s\-().]/g, '').trim();
  }

  const DEFAULT_CONFIG = {
    formPhoneMode: 'optional',
    reviewQnaDisplayMode: 'tabs',
    curatedSliderEnabled: true,
    curatedSliderCount: 15,
  };

  const RENDER_DEFAULTS = {
    titleText: 'Đánh giá sản phẩm',
    accentColor: '#f59e0b',
    starColor: '#f59e0b',
    starBgColor: '#b3bcc5',
    starIconUrl: '',
    textColor: '#1a1a1a',
    mutedColor: '#6b7280',
    bgColor: '#ffffff',
    bgAltColor: '#f8fafc',
    borderColor: '#e5e7eb',
    verifiedColor: '#01ab56',
    radius: 12,
    showTitle: true,
    showDate: true,
    showFilter: true,
    showSort: true,
    formEmailMode: 'optional',
    formTitleMode: 'optional',
    formContentMode: 'optional',
    requireLogin: false,
    allowQnA: true,
    reviewItemsPerPage: 5,
    qnaItemsPerPage: 5,
    allowImage: true,
    allowVideo: true,
    allowReply: true,
    replyBadgeText: 'Phản hồi từ Shop',
    replyBgColor: '#f0f5ff',
    replyBorderColor: '#1677ff',
    showVerified: true,
    showVerifiedAll: false,
    reviewLayout: 'list',
    qnaDisplayMode: 'list',
    requirePurchaseToReview: false,
  };

  const FALLBACK_CONFIG = { ...RENDER_DEFAULTS, ...DEFAULT_CONFIG };

  const CONFIG_CACHE = new Map();
  const CONFIG_CACHE_TTL = 30000;
  const REVIEW_SUMMARY_CACHE = new Map();
  const REVIEW_SUMMARY_INFLIGHT = new Map();
  const REVIEW_SUMMARY_BATCHES = new Map();
  const REVIEW_LIST_CACHE = new Map();
  const QNA_LIST_CACHE = new Map();
  const PURCHASE_ELIGIBILITY_CACHE = new Map();
  const REVIEW_SUMMARY_BATCH_DELAY = 25;
  const REVIEW_SUMMARY_BATCH_LIMIT = 100;
  const PUBLIC_PAGE_SIZE = 50;
  const PUBLIC_MAX_PAGES = 20;
  const PURCHASE_ELIGIBILITY_CACHE_TTL = 30000;
  const MAX_MEDIA_FILES = 5;
  const IMAGE_MAX_SIZE = 5 * 1024 * 1024; // must equal the server image limit
  const IMAGE_SOFT_TARGET = Math.floor(1.5 * 1024 * 1024);
  const VIDEO_MAX_SIZE = 2 * 1024 * 1024;
  const IMAGE_COMPRESS_MAX_EDGE = 1920;
  const CRITICAL_STYLE_ID = 'f1genz-sapo-review-critical-style';

  function ensureCriticalStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(CRITICAL_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = CRITICAL_STYLE_ID;
    style.textContent = [
      '.f1genz-sapo-review-file-wrap{position:relative;display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.f1genz-sapo-review-file-wrap input[type="file"],',
      '.f1genz-sapo-review-file-wrap input.f1genz-sapo-review-file-input,',
      '#f1genz-sapo-review-input-media{display:none!important;appearance:none!important;-webkit-appearance:none!important;position:absolute!important;width:0!important;height:0!important;padding:0!important;margin:0!important;overflow:hidden!important;border:0!important;opacity:0!important;pointer-events:none!important}',
      'label.f1genz-sapo-review-file-trigger{display:inline-flex;align-items:center;justify-content:center;cursor:pointer;margin:0;user-select:none}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureStorefrontStylesheet() {
    if (typeof document === 'undefined') return;
    const apiUrl = resolveRuntimeApiUrl();
    if (!apiUrl) return;
    const href = `${apiUrl}/storefront/f1genz-storefront.css`;
    const links = Array.from(document.querySelectorAll('link[href*="f1genz-storefront.css"]'));
    const hasApplied = links.some((link) => {
      const rel = String(link.rel || '').toLowerCase();
      return rel.split(/\s+/).includes('stylesheet') && !rel.includes('preload');
    });
    if (hasApplied) return;
    links.forEach((link) => {
      const rel = String(link.rel || '').toLowerCase();
      if (rel.includes('preload') || !rel.split(/\s+/).includes('stylesheet')) {
        link.rel = 'stylesheet';
        link.removeAttribute('as');
      }
    });
    if (!links.length) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      (document.head || document.documentElement).appendChild(link);
    }
  }

  ensureCriticalStyles();
  ensureStorefrontStylesheet();

  const AVATAR_COLORS = [
    '#f43f5e',
    '#ec4899',
    '#d946ef',
    '#8b5cf6',
    '#6366f1',
    '#3b82f6',
    '#0ea5e9',
    '#06b6d4',
    '#14b8a6',
    '#10b981',
    '#22c55e',
    '#84cc16',
    '#eab308',
    '#f59e0b',
    '#f97316',
  ];

  const normalizeRadius = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : RENDER_DEFAULTS.radius;
  };

  function escapeHTML(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function richTextAnchor(url, label) {
    return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer nofollow" class="f1genz-sapo-link">${escapeHTML(label)}</a>`;
  }

  function formatSafeRichText(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    const pattern = /\[([^\]\r\n]+)\]\s*\(\s*(https?:\/\/[^\s()<>"]+)\s*\)|(^|[\s("“])(https?:\/\/[^\s<>")”]+)/gi;
    let output = '';
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text))) {
      output += escapeHTML(text.slice(cursor, match.index));
      if (match[2]) {
        output += richTextAnchor(match[2], match[1]);
      } else {
        const trailing = /[.,;:!?]+$/.exec(match[4]);
        const url = trailing ? match[4].slice(0, -trailing[0].length) : match[4];
        output += escapeHTML(match[3]) + richTextAnchor(url, url) + (trailing ? escapeHTML(trailing[0]) : '');
      }
      cursor = pattern.lastIndex;
    }
    output += escapeHTML(text.slice(cursor));
    return output.replace(/\r?\n/g, '<br>');
  }

  function withStoreDomainParam(url, storeDomain) {
    const normalizedStoreDomain = String(storeDomain || '').trim();
    if (!normalizedStoreDomain) return url;
    const hashIndex = url.indexOf('#');
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const separator = base.indexOf('?') >= 0 ? '&' : '?';
    return `${base}${separator}storeDomain=${encodeURIComponent(normalizedStoreDomain)}${hash}`;
  }

  function fetchJSON(url, storeDomain, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    const requestUrl = method === 'GET' || method === 'HEAD' ? withStoreDomainParam(url, storeDomain) : url;
    if (storeDomain && method !== 'GET' && method !== 'HEAD') {
      headers['x-store-domain'] = storeDomain;
    }
    const request = { cache: 'no-store', ...options, method, headers };
    if (request.body && !(request.body instanceof FormData)) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(request.body);
    }
    return fetch(requestUrl, request).then(async (response) => {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        let message = '';
        if (payload && typeof payload === 'object') {
          const nestedMessage = payload.data && typeof payload.data === 'object'
            ? payload.data.message
            : null;
          if (Array.isArray(payload.message)) {
            message = payload.message.join(', ');
          } else if (typeof payload.message === 'string') {
            message = payload.message;
          } else if (typeof nestedMessage === 'string') {
            message = nestedMessage;
          } else if (typeof payload.error === 'string') {
            message = payload.error;
          }
        }
        const failure = new Error(message || `API Error ${response.status}`);
        failure.status = response.status;
        failure.code = payload && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : '';
        throw failure;
      }

      if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
        return payload.data;
      }
      return payload;
    });
  }

  const PUBLIC_ERROR_MESSAGES = {
    identity_required: 'Vui lòng nhập Email hoặc Số điện thoại để xác minh mua hàng.',
    purchase_required: 'Chỉ khách đã mua sản phẩm này mới có thể đánh giá.',
    purchase_check_unavailable: 'Chưa xác minh được đơn mua hàng lúc này. Vui lòng thử lại sau.',
    store_not_serving: 'Cửa hàng hiện chưa nhận nội dung gửi từ khách. Vui lòng thử lại sau.',
    qna_disabled: 'Cửa hàng đã tắt chức năng hỏi đáp.',
    product_not_found: 'Không tìm thấy sản phẩm này. Vui lòng tải lại trang.',
    media_type_not_allowed: 'Cửa hàng không nhận loại tệp này (ảnh hoặc video). Vui lòng bỏ tệp và thử lại.',
  };
  const RATE_LIMIT_MESSAGE = 'Bạn thao tác quá nhanh. Vui lòng đợi một lúc rồi thử lại.';

  function publicErrorMessage(error, fallback) {
    if (error && typeof error.code === 'string' && Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_MESSAGES, error.code)) {
      return PUBLIC_ERROR_MESSAGES[error.code];
    }
    if (error && error.status === 429) return RATE_LIMIT_MESSAGE;
    return error instanceof Error && error.message ? error.message : fallback;
  }

  function normalizeFormMode(value, fallback, legacyRequired) {
    if (value === 'hidden' || value === 'optional' || value === 'required') return value;
    if (legacyRequired === true) return 'required';
    if (legacyRequired === false && fallback === 'required') return 'optional';
    return fallback;
  }

  function normalizeWidgetConfig(config) {
    const source = config || {};
    const next = {
      ...FALLBACK_CONFIG,
      ...source,
    };
    next.formTitleMode = normalizeFormMode(source.formTitleMode, FALLBACK_CONFIG.formTitleMode);
    next.formContentMode = normalizeFormMode(source.formContentMode, FALLBACK_CONFIG.formContentMode, source.formContentRequired);
    next.formEmailMode = normalizeFormMode(source.formEmailMode, FALLBACK_CONFIG.formEmailMode);
    next.formPhoneMode = normalizeFormMode(source.formPhoneMode, FALLBACK_CONFIG.formPhoneMode);
    next.reviewQnaDisplayMode = source.reviewQnaDisplayMode === 'tabs' || source.reviewQnaDisplayMode === 'stacked'
      ? source.reviewQnaDisplayMode
      : FALLBACK_CONFIG.reviewQnaDisplayMode;
    return next;
  }

  function getFormContentMode(config) {
    return normalizeFormMode(config && config.formContentMode, FALLBACK_CONFIG.formContentMode, config && config.formContentRequired);
  }

  function getFormPhoneMode(config) {
    return normalizeFormMode(config && config.formPhoneMode, FALLBACK_CONFIG.formPhoneMode);
  }

  function getFormEmailMode(config) {
    return normalizeFormMode(config && config.formEmailMode, FALLBACK_CONFIG.formEmailMode);
  }

  function requiresPurchaseIdentity(config) {
    return !!(config && config.requirePurchaseToReview);
  }

  function isValidEmail(value) {
    return /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(String(value || '').trim());
  }

  function isValidPhone(value) {
    const cleaned = String(value || '').trim().replace(/[\s\-().]/g, '');
    if (!cleaned) return false;
    return /^(0[2-9]\d{8}|(\+?84)[2-9]\d{8})$/.test(cleaned);
  }

  function normalizeHttpsUrl(value) {
    const url = String(value || '').trim();
    return /^https:\/\/[^\s<>"']{1,2000}$/i.test(url) ? url : '';
  }

  const SUBMITTABLE_VIDEO_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com', 'player.vimeo.com'];

  function normalizeVideoLink(value) {
    const url = normalizeHttpsUrl(value);
    if (!url) return '';
    try {
      if (!SUBMITTABLE_VIDEO_HOSTS.includes(new URL(url).host.toLowerCase())) return '';
    } catch {
      return '';
    }
    return getVideoEmbedUrl(url) ? url : '';
  }

  function isDirectVideoUrl(value) {
    return /\.(mp4|webm|ogg)(?:[?#].*)?$/i.test(String(value || '').trim());
  }

  function getVideoEmbedUrl(value) {
    const url = normalizeHttpsUrl(value);
    if (!url) return '';
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      if (host === 'youtube.com' || host === 'm.youtube.com') {
        const id = parsed.searchParams.get('v');
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
        const shorts = /^\/shorts\/([^/?#]+)/.exec(parsed.pathname);
        if (shorts && shorts[1]) return `https://www.youtube.com/embed/${encodeURIComponent(shorts[1])}`;
        const embed = /^\/embed\/([^/?#]+)/.exec(parsed.pathname);
        if (embed && embed[1]) return `https://www.youtube.com/embed/${encodeURIComponent(embed[1])}`;
      }
      if (host === 'youtu.be') {
        const id = parsed.pathname.split('/').filter(Boolean)[0];
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
      }
      if (host === 'vimeo.com') {
        const id = parsed.pathname.split('/').filter(Boolean)[0];
        if (/^\d+$/.test(id || '')) return `https://player.vimeo.com/video/${id}`;
      }
      if (parsed.hostname.toLowerCase() === 'player.vimeo.com') {
        const player = /^\/video\/(\d+)/.exec(parsed.pathname);
        if (player) return `https://player.vimeo.com/video/${player[1]}`;
      }
    } catch {
      return '';
    }
    return '';
  }

  function getWidgetConfig(apiUrl, storeDomain, options) {
    const cacheKey = `${apiUrl}::${storeDomain}`;
    const cached = CONFIG_CACHE.get(cacheKey);
    const now = Date.now();
    const force = !!(options && options.force);
    if (!force && cached && now - cached.createdAt < CONFIG_CACHE_TTL) {
      return cached.promise;
    }

    const promise = fetchJSON(`${apiUrl}/api/public/reviews/config/widget`, storeDomain)
      .then((config) => normalizeWidgetConfig(config))
      .catch(() => {
        CONFIG_CACHE.delete(cacheKey);
        return normalizeWidgetConfig();
      });
    CONFIG_CACHE.set(cacheKey, { createdAt: now, promise });
    return promise;
  }

  function getPurchaseEligibility(apiUrl, storeDomain, productId, identity, options) {
    const email = String(identity && identity.email ? identity.email : '').trim();
    const phone = String(identity && identity.phone ? identity.phone : '').trim();
    const normalizedProductId = String(productId || '').trim();
    if (!apiUrl || !storeDomain || !normalizedProductId || (!email && !phone)) {
      return Promise.resolve({ eligible: false, reason: 'missing_identity' });
    }

    const cacheKey = `${apiUrl}::${storeDomain}::${normalizedProductId}::${email.toLowerCase()}::${phone}`;
    const cached = PURCHASE_ELIGIBILITY_CACHE.get(cacheKey);
    const now = Date.now();
    const force = !!(options && options.force);
    if (!force && cached && now - cached.createdAt < PURCHASE_ELIGIBILITY_CACHE_TTL) {
      return cached.promise;
    }

    const promise = fetchJSON(`${apiUrl}/api/public/reviews/${encodeURIComponent(normalizedProductId)}/purchase-eligibility`, storeDomain, {
      method: 'POST',
      body: { email, phone },
    }).then((result) => ({
      eligible: !!(result && result.eligible),
      reason: result && result.reason ? String(result.reason) : 'not_purchased',
    }));
    PURCHASE_ELIGIBILITY_CACHE.set(cacheKey, { createdAt: now, promise });
    return promise;
  }

  function emptyReviewSummary() {
    return { avg: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  }

  function reviewCacheKey(apiUrl, storeDomain, productId) {
    return `${apiUrl}::${storeDomain}::${String(productId || '').trim()}`;
  }

  function calculateReviewSummaryFromReviews(reviews) {
    const summary = emptyReviewSummary();
    if (!Array.isArray(reviews) || !reviews.length) return summary;
    reviews.forEach((review) => {
      const rating = Number(review && review.rating);
      if (rating >= 1 && rating <= 5) {
        summary.distribution[rating] += 1;
        summary.count += 1;
      }
    });
    summary.avg = summary.count
      ? Math.round((Object.entries(summary.distribution).reduce((sum, [star, count]) => sum + Number(star) * count, 0) / summary.count) * 10) / 10
      : 0;
    return summary;
  }

  function calculateQnaSummaryFromQuestions(questions) {
    const safeQuestions = Array.isArray(questions) ? questions : [];
    const total = safeQuestions.length;
    const answered = safeQuestions.filter((question) => !!question.answer).length;
    return { total, answered, unanswered: total - answered };
  }

  function clearReviewCache(apiUrl, storeDomain, productId) {
    const key = reviewCacheKey(apiUrl, storeDomain, productId);
    REVIEW_LIST_CACHE.delete(key);
    REVIEW_SUMMARY_CACHE.delete(key);
  }

  function clearQnaCache(apiUrl, storeDomain, productId) {
    QNA_LIST_CACHE.delete(reviewCacheKey(apiUrl, storeDomain, productId));
  }

  function readPublicPage(payload) {
    if (Array.isArray(payload)) return { rows: payload, total: null };
    if (payload && Array.isArray(payload.items)) {
      const total = Number(payload.total);
      return { rows: payload.items, total: Number.isFinite(total) ? total : null };
    }
    return { rows: [], total: null };
  }

  async function fetchAllPublicPages(baseUrl, storeDomain) {
    const seen = new Set();
    const rows = [];
    for (let pageNumber = 1; pageNumber <= PUBLIC_MAX_PAGES; pageNumber += 1) {
      let payload;
      try {
        payload = await fetchJSON(`${baseUrl}?page=${pageNumber}&limit=${PUBLIC_PAGE_SIZE}`, storeDomain);
      } catch (error) {
        if (pageNumber === 1) throw error;
        break;
      }
      const page = readPublicPage(payload);
      let added = 0;
      page.rows.forEach((row) => {
        const key = String(row && row.id != null ? row.id : '');
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        rows.push(row);
        added += 1;
      });
      if (!added || page.rows.length < PUBLIC_PAGE_SIZE || (page.total !== null && rows.length >= page.total)) break;
    }
    return rows;
  }

  function getPublicReviews(apiUrl, storeDomain, productId) {
    const normalizedProductId = String(productId || '').trim();
    if (!apiUrl || !storeDomain || !normalizedProductId) return Promise.resolve([]);
    const cacheKey = reviewCacheKey(apiUrl, storeDomain, normalizedProductId);
    if (REVIEW_LIST_CACHE.has(cacheKey)) return REVIEW_LIST_CACHE.get(cacheKey);

    const request = fetchAllPublicPages(`${apiUrl}/api/public/reviews/${encodeURIComponent(normalizedProductId)}`, storeDomain)
      .catch((error) => {
        REVIEW_LIST_CACHE.delete(cacheKey);
        throw error;
      });
    REVIEW_LIST_CACHE.set(cacheKey, request);
    return request;
  }

  function getPublicQuestions(apiUrl, storeDomain, productId) {
    const normalizedProductId = String(productId || '').trim();
    if (!apiUrl || !storeDomain || !normalizedProductId) return Promise.resolve([]);
    const cacheKey = reviewCacheKey(apiUrl, storeDomain, normalizedProductId);
    if (QNA_LIST_CACHE.has(cacheKey)) return QNA_LIST_CACHE.get(cacheKey);

    const request = fetchAllPublicPages(`${apiUrl}/api/public/qna/${encodeURIComponent(normalizedProductId)}`, storeDomain)
      .catch((error) => {
        QNA_LIST_CACHE.delete(cacheKey);
        throw error;
      });
    QNA_LIST_CACHE.set(cacheKey, request);
    return request;
  }

  function getReviewSummary(apiUrl, storeDomain, productId) {
    const normalizedProductId = String(productId || '').trim();
    if (!apiUrl || !storeDomain || !normalizedProductId) {
      return Promise.resolve(emptyReviewSummary());
    }

    const cacheKey = `${apiUrl}::${storeDomain}::${normalizedProductId}`;
    if (REVIEW_SUMMARY_CACHE.has(cacheKey)) {
      return Promise.resolve(REVIEW_SUMMARY_CACHE.get(cacheKey));
    }
    if (REVIEW_SUMMARY_INFLIGHT.has(cacheKey)) {
      return REVIEW_SUMMARY_INFLIGHT.get(cacheKey);
    }

    const batchKey = `${apiUrl}::${storeDomain}`;
    let batch = REVIEW_SUMMARY_BATCHES.get(batchKey);
    if (!batch) {
      batch = { apiUrl, storeDomain, items: new Map(), timer: null };
      REVIEW_SUMMARY_BATCHES.set(batchKey, batch);
    }

    const promise = new Promise((resolve, reject) => {
      const subscribers = batch.items.get(normalizedProductId) || [];
      subscribers.push({ resolve, reject });
      batch.items.set(normalizedProductId, subscribers);
    });
    REVIEW_SUMMARY_INFLIGHT.set(cacheKey, promise);

    if (!batch.timer) {
      batch.timer = window.setTimeout(() => flushReviewSummaryBatch(batchKey), REVIEW_SUMMARY_BATCH_DELAY);
    }

    return promise;
  }

  function flushReviewSummaryBatch(batchKey) {
    const batch = REVIEW_SUMMARY_BATCHES.get(batchKey);
    if (!batch) return;
    REVIEW_SUMMARY_BATCHES.delete(batchKey);

    const productIds = Array.from(batch.items.keys());
    const chunks = [];
    for (let index = 0; index < productIds.length; index += REVIEW_SUMMARY_BATCH_LIMIT) {
      chunks.push(productIds.slice(index, index + REVIEW_SUMMARY_BATCH_LIMIT));
    }

    Promise.all(
      chunks.map((ids) =>
        fetchJSON(
          `${batch.apiUrl}/api/public/reviews/summaries?productIds=${ids.map(encodeURIComponent).join(',')}`,
          batch.storeDomain,
        ),
      ),
    ).then((results) => {
      const summaries = Object.assign({}, ...results);
      productIds.forEach((productId) => {
        const cacheKey = `${batch.apiUrl}::${batch.storeDomain}::${productId}`;
        const summary = summaries[productId] || emptyReviewSummary();
        REVIEW_SUMMARY_CACHE.set(cacheKey, summary);
        REVIEW_SUMMARY_INFLIGHT.delete(cacheKey);
        (batch.items.get(productId) || []).forEach(({ resolve }) => resolve(summary));
      });
    }).catch((error) => {
      productIds.forEach((productId) => {
        const cacheKey = `${batch.apiUrl}::${batch.storeDomain}::${productId}`;
        REVIEW_SUMMARY_INFLIGHT.delete(cacheKey);
        (batch.items.get(productId) || []).forEach(({ reject }) => reject(error));
      });
    });
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
  }

  function avatarColor(name) {
    const seed = String(name || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return AVATAR_COLORS[seed % AVATAR_COLORS.length];
  }

  function timeAgo(timestamp) {
    if (!timestamp) return '';
    let seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 1000));
    if (seconds < 60) return 'Vừa xong';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)} ngày trước`;
    const date = new Date(Number(timestamp));
    const day = `${date.getDate()}`.padStart(2, '0');
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    return `${day}/${month}/${date.getFullYear()}`;
  }

  function renderStar(config, filled, size) {
    if (config.starIconUrl) {
      return `<img src="${escapeHTML(config.starIconUrl)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px;object-fit:contain;opacity:${filled ? '1' : '0.25'}">`;
    }
    const color = filled
      ? (config.starColor || RENDER_DEFAULTS.starColor)
      : (config.starBgColor || RENDER_DEFAULTS.starBgColor);
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" style="color:${escapeHTML(color)}"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  }

  function relativeLuminance(hex) {
    const value = String(hex || '').trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null;
    const full = value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
    const channels = [1, 3, 5].map((offset) => {
      const channel = parseInt(full.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function readableTextOn(background) {
    const luminance = relativeLuminance(background);
    if (luminance === null) return '#fff';
    const contrastWithWhite = 1.05 / (luminance + 0.05);
    return contrastWithWhite >= 4.5 ? '#fff' : RENDER_DEFAULTS.textColor;
  }

  function renderStars(config, rating, size) {
    let html = '';
    for (let index = 1; index <= 5; index += 1) {
      html += renderStar(config, Number(rating) >= index, size);
    }
    return html;
  }

  function collectReviewMedia(review, config) {
    const entries = [];
    if (Array.isArray(review.media) && review.media.length) {
      entries.push(...review.media);
    } else {
      if (Array.isArray(review.images)) {
        review.images.forEach((url) => entries.push({ url, type: 'image' }));
      }
      if (review.video) entries.push({ url: review.video, type: 'video' });
    }
    return entries
      .map((item) => ({
        src: typeof item === 'string' ? item : item.url,
        type: typeof item === 'string' ? 'image' : (item.type || 'image'),
      }))
      .filter((item) => item.src && String(item.src).startsWith('http'))
      .filter((item) => (item.type === 'video' ? config.allowVideo !== false : config.allowImage !== false));
  }

  function normalizeReview(review, config) {
    const media = collectReviewMedia(review, config);
    return {
      ...review,
      __f1genzappReviewMedia: media,
      __f1genzappReviewHasMedia: media.length > 0,
    };
  }

  function getReviewKey(review, fallbackIndex) {
    const value = review && (review.id || review.reviewId || review._id || review.created_at);
    return String(value == null || value === '' ? fallbackIndex : value);
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Không đọc được ảnh. Thử JPEG/PNG/WebP.'));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => resolve(blob || null), type, quality);
        return;
      }
      try {
        const dataUrl = canvas.toDataURL(type, quality);
        const parts = dataUrl.split(',');
        const byteString = atob(parts[1] || '');
        const mimeMatch = parts[0] && parts[0].match(/:(.*?);/);
        const mime = (mimeMatch && mimeMatch[1]) || type;
        const buffer = new ArrayBuffer(byteString.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < byteString.length; i += 1) view[i] = byteString.charCodeAt(i);
        resolve(new Blob([buffer], { type: mime }));
      } catch {
        resolve(null);
      }
    });
  }

  function toUploadFile(blobOrFile, filename, type) {
    if (typeof File === 'function') {
      return new File([blobOrFile], filename, {
        type: type || blobOrFile.type || 'application/octet-stream',
        lastModified: Date.now(),
      });
    }
    const blob = blobOrFile instanceof Blob
      ? blobOrFile
      : new Blob([blobOrFile], { type: type || 'application/octet-stream' });
    try {
      blob.name = filename;
    } catch {
    }
    return blob;
  }

  function imageBaseName(file) {
    const raw = String((file && file.name) || 'review-image').trim() || 'review-image';
    return raw.replace(/\.[^.]+$/, '') || 'review-image';
  }

  async function prepareImageForUpload(file) {
    if (!file || !String(file.type || '').startsWith('image/')) return file;
    if (file.size <= IMAGE_SOFT_TARGET) return file;

    let img;
    try {
      img = await loadImageElement(file);
    } catch {
      if (file.size <= IMAGE_MAX_SIZE) return file;
      throw new Error('Không đọc được ảnh để nén. Dùng JPEG/PNG/WebP.');
    }

    const srcW = img.naturalWidth || img.width || 0;
    const srcH = img.naturalHeight || img.height || 0;
    if (!srcW || !srcH) {
      if (file.size <= IMAGE_MAX_SIZE) return file;
      throw new Error('Ảnh không hợp lệ.');
    }

    let scale = Math.min(1, IMAGE_COMPRESS_MAX_EDGE / Math.max(srcW, srcH));
    let quality = 0.82;
    let bestBlob = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const width = Math.max(1, Math.round(srcW * scale));
      const height = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(img, 0, 0, width, height);

      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      if (!blob) break;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;

      if (blob.size <= IMAGE_SOFT_TARGET) {
        return toUploadFile(blob, `${imageBaseName(file)}.jpg`, 'image/jpeg');
      }

      quality = Math.max(0.45, quality - 0.1);
      if (quality <= 0.5 && scale > 0.35) {
        scale *= 0.75;
        quality = 0.72;
      }
    }

    if (bestBlob && bestBlob.size <= IMAGE_MAX_SIZE) {
      return toUploadFile(bestBlob, `${imageBaseName(file)}.jpg`, 'image/jpeg');
    }
    if (file.size <= IMAGE_MAX_SIZE) return file;
    throw new Error('Không nén được ảnh xuống dưới 5MB. Chọn ảnh nhỏ hơn.');
  }

  function uploadPublicFile(apiUrl, storeDomain, productId, file) {
    const filename = file.name || 'review-image.jpg';
    const contentType = file.type || 'application/octet-stream';
    return fetchJSON(`${apiUrl}/api/public/media/ticket`, storeDomain, {
      method: 'POST',
      body: {
        productId,
        contentType,
        fileSize: file.size,
      },
    }).then((ticketData) => {
      const formData = new FormData();
      formData.append('file', file, filename);
      return fetchJSON(
        `${apiUrl}/api/public/media/upload?productId=${encodeURIComponent(productId)}&ticket=${encodeURIComponent(ticketData.ticket)}`,
        storeDomain,
        { method: 'POST', body: formData },
      );
    });
  }

  function normalizePageSize(value, fallback = 5) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, parsed);
  }

  function getMasonryColumnCount(width) {
    if (width <= 600) return 1;
    if (width <= 900) return 2;
    if (width <= 1200) return 3;
    return 4;
  }

  function splitIntoMasonryColumns(items, columnCount) {
    const totalColumns = Math.max(1, columnCount);
    const columns = Array.from({ length: totalColumns }, () => []);
    items.forEach((item, index) => {
      columns[index % totalColumns].push(item);
    });
    return columns;
  }

  function getPaginationItems(currentPage, totalPages) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const pages = [1];
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);

    if (start > 2) pages.push('ellipsis-start');
    for (let page = start; page <= end; page += 1) pages.push(page);
    if (end < totalPages - 1) pages.push('ellipsis-end');
    pages.push(totalPages);
    return pages;
  }

  function renderPagination(currentPage, totalPages) {
    if (totalPages <= 1) return '';

    const items = getPaginationItems(currentPage, totalPages);
    return `<nav class="f1genz-sapo-review-pagination" aria-label="Phân trang"><button type="button" class="f1genz-sapo-review-pagination__btn" data-action="page-prev" aria-label="Trang trước" ${currentPage <= 1 ? 'disabled' : ''}>Trước</button>
      ${items.map((item) => {
        if (String(item).startsWith('ellipsis')) {
          return '<span class="f1genz-sapo-review-pagination__ellipsis" aria-hidden="true">…</span>';
        }
        return `<button type="button" class="f1genz-sapo-review-pagination__btn ${item === currentPage ? 'f1genz-sapo-review-pagination__btn--active' : ''}" data-action="page-set" data-page="${item}" aria-label="Trang ${item}" ${item === currentPage ? 'aria-current="page"' : ''}>${item}</button>`;
      }).join('')}
      <button type="button" class="f1genz-sapo-review-pagination__btn" data-action="page-next" aria-label="Trang sau" ${currentPage >= totalPages ? 'disabled' : ''}>Sau</button></nav>`;
  }

  class F1GBaseElement extends HTMLElement {
    constructor() {
      super();
      this.config = { ...FALLBACK_CONFIG };
      this.state = {};
      this._bootPromise = null;
    }

    get shouldRequireLogin() {
      return !!this.config.requireLogin && !this.hasCustomerIdentity;
    }

    get apiUrl() {
      return resolveRuntimeApiUrl();
    }

    get storeDomain() {
      return this.getAttribute('storeDomain') || '';
    }

    get productId() {
      return this.getAttribute('product-id') || '';
    }

    get customerEmail() {
      return this.getAttribute('customer-email') || '';
    }

    get customerPhone() {
      return this.getAttribute('customer-phone') || '';
    }

    get hasCustomerIdentity() {
      return !!(String(this.customerEmail).trim() || String(this.customerPhone).trim());
    }

    connectedCallback() {
      if (!this._bootPromise) {
        this._bootPromise = this.bootstrap();
      }
    }

    async bootstrap() {
      ensureCriticalStyles();
      ensureStorefrontStylesheet();
      if (!this.apiUrl || !this.storeDomain) {
        this.renderPlaceholder('');
        return;
      }
      try {
        this.config = await getWidgetConfig(this.apiUrl, this.storeDomain);
      } catch {
        this.config = { ...FALLBACK_CONFIG };
      }
      this.applyTheme(this.config);
      await this.initialize();
    }

    async initialize() {}

    applyTheme(config) {
      const radius = normalizeRadius(config.radius);
      const radiusSm = Math.max(0, Math.round(radius * 0.67));
      const radiusXs = Math.max(0, Math.round(radius * 0.5));

      this.style.setProperty('--f1genz-sapo-review-accent', config.accentColor || RENDER_DEFAULTS.accentColor);
      this.style.setProperty('--f1genz-sapo-review-on-accent', readableTextOn(config.accentColor || RENDER_DEFAULTS.accentColor));
      this.style.setProperty('--f1genz-sapo-review-star-color', config.starColor || RENDER_DEFAULTS.starColor);
      this.style.setProperty('--f1genz-sapo-review-star-empty', config.starBgColor || RENDER_DEFAULTS.starBgColor);
      this.style.setProperty('--f1genz-sapo-review-text', config.textColor || RENDER_DEFAULTS.textColor);
      this.style.setProperty('--f1genz-sapo-review-text-muted', config.mutedColor || RENDER_DEFAULTS.mutedColor);
      this.style.setProperty('--f1genz-sapo-review-bg', config.bgColor || RENDER_DEFAULTS.bgColor);
      this.style.setProperty('--f1genz-sapo-review-bg-alt', config.bgAltColor || RENDER_DEFAULTS.bgAltColor);
      this.style.setProperty('--f1genz-sapo-review-border', config.borderColor || RENDER_DEFAULTS.borderColor);
      this.style.setProperty('--f1genz-sapo-review-radius', `${radius}px`);
      this.style.setProperty('--f1genz-sapo-review-radius-sm', `${radiusSm}px`);
      this.style.setProperty('--f1genz-sapo-review-radius-xs', `${radiusXs}px`);
      this.style.setProperty('--f1genz-sapo-review-verified', config.verifiedColor || RENDER_DEFAULTS.verifiedColor);
      this.style.setProperty('--f1genz-sapo-review-reply-bg', config.replyBgColor || RENDER_DEFAULTS.replyBgColor);
      this.style.setProperty('--f1genz-sapo-review-reply-border', config.replyBorderColor || RENDER_DEFAULTS.replyBorderColor);
    }

    renderTemplate(markup) {
      this.innerHTML = markup || '';
    }

    renderPlaceholder(message) {
      this.renderTemplate(message ? `<div class="f1genz-sapo-review-placeholder">${escapeHTML(message)}</div>` : '');
    }
  }

  class F1GReviewsElement extends F1GBaseElement {
    constructor() {
      super();
      this.visibleReviews = [];
      this.previewUrls = [];
      this._filteredReviewsCacheKey = '';
      this._filteredReviewsCacheValue = [];
      this._resizeFrame = 0;
      this._lastMasonryColumns = getMasonryColumnCount(window.innerWidth || 1280);
      this._resizeBound = false;
      this._formTitleId = `f1genz-sapo-review-form-title-${Math.random().toString(36).slice(2)}`;
      this._reviewDetailTitleId = `f1genz-sapo-review-detail-title-${Math.random().toString(36).slice(2)}`;
      this.handleKeydown = (event) => {
        if (event.key === 'Escape') {
          if (this.state.lightboxOpen) this.closeLightbox();
          else if (this.state.reviewDetailKey) this.closeReviewDetail();
          else if (this.state.formOpen) this.closeForm();
        }
        if (!this.state.lightboxOpen || !this.state.lightboxItems.length) return;
        if (event.key === 'ArrowLeft') {
          this.state.lightboxIndex = (this.state.lightboxIndex - 1 + this.state.lightboxItems.length) % this.state.lightboxItems.length;
          this.renderLightboxRegion();
        }
        if (event.key === 'ArrowRight') {
          this.state.lightboxIndex = (this.state.lightboxIndex + 1) % this.state.lightboxItems.length;
          this.renderLightboxRegion();
        }
      };
      this.handleResize = () => {
        if (this.config.reviewLayout !== 'masonry') return;
        if (this._resizeFrame) window.cancelAnimationFrame(this._resizeFrame);
        this._resizeFrame = window.requestAnimationFrame(() => {
          this._resizeFrame = 0;
          const nextColumns = getMasonryColumnCount(window.innerWidth || 1280);
          if (nextColumns === this._lastMasonryColumns) return;
          this._lastMasonryColumns = nextColumns;
          this.renderListRegion();
        });
      };
      this.state = {
        loading: true,
        reviews: [],
        reviewsVersion: 0,
        summary: { avg: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
        page: 1,
        filterStar: 0,
        filterHasMedia: false,
        sortBy: 'newest',
        formOpen: false,
        formRating: 0,
        formFiles: [],
        formDraft: { title: '', content: '', author: '', email: '', phone: '', videoUrl: '' },
        formSubmitting: false,
        formError: '',
        formSuccess: '',
        purchaseEligibility: { loading: false, checked: false, eligible: false, reason: '' },
        lightboxOpen: false,
        lightboxItems: [],
        lightboxIndex: 0,
        reviewDetailKey: '',
      };
      this._eventsBound = false;
    }

    connectedCallback() {
      if (!this._eventsBound) {
        this.addEventListener('click', (event) => this.handleClick(event));
        this.addEventListener('change', (event) => this.handleChange(event));
        this.addEventListener('input', (event) => this.handleInput(event));
        this._eventsBound = true;
      }
      window.addEventListener('keydown', this.handleKeydown);
      super.connectedCallback();
    }

    disconnectedCallback() {
      window.removeEventListener('keydown', this.handleKeydown);
      if (this._resizeBound) {
        window.removeEventListener('resize', this.handleResize);
        this._resizeBound = false;
      }
      if (this._resizeFrame) {
        window.cancelAnimationFrame(this._resizeFrame);
        this._resizeFrame = 0;
      }
      this.syncPreviewUrls([]);
    }

    syncResizeListener() {
      const shouldListen = this.config.reviewLayout === 'masonry';
      if (shouldListen && !this._resizeBound) {
        window.addEventListener('resize', this.handleResize, { passive: true });
        this._resizeBound = true;
        return;
      }
      if (!shouldListen && this._resizeBound) {
        window.removeEventListener('resize', this.handleResize);
        this._resizeBound = false;
      }
    }

    async initialize() {
      if (!this.productId) {
        this.renderPlaceholder('');
        return;
      }
      this.syncResizeListener();
      this.render();
      await Promise.all([
        this.reloadData(),
        this.refreshPurchaseEligibility(),
      ]);
      if (requiresPurchaseIdentity(this.config)) {
        this.renderSummaryRegion();
      }
    }

    async reloadData(showLoader = true) {
      if (showLoader) {
        this.state.loading = true;
        this.render();
      }
      try {
        const [reviews, remoteSummary] = await Promise.all([
          getPublicReviews(this.apiUrl, this.storeDomain, this.productId),
          this.productId
            ? fetchJSON(`${this.apiUrl}/api/public/reviews/${encodeURIComponent(this.productId)}/summary`, this.storeDomain).catch(() => null)
            : null,
        ]);
        const calculatedSummary = calculateReviewSummaryFromReviews(reviews);
        const summary = remoteSummary && typeof remoteSummary === 'object'
          ? { ...calculatedSummary, ...remoteSummary }
          : calculatedSummary;
        this.state.loading = false;
        this.state.reviews = Array.isArray(reviews)
          ? reviews.map((review) => normalizeReview(review, this.config))
          : [];
        this.state.reviewsVersion += 1;
        this.invalidateFilteredReviewsCache();
        this._lastMasonryColumns = getMasonryColumnCount(window.innerWidth || 1280);
        this.state.summary = summary || this.state.summary;
        this.renderReviewRegions();
      } catch {
        this.state.loading = false;
        this.renderPlaceholder('');
      }
    }

    syncPreviewUrls(files) {
      this.previewUrls.forEach((url) => URL.revokeObjectURL(url));
      this.previewUrls = files.map((file) => URL.createObjectURL(file));
    }

    invalidateFilteredReviewsCache() {
      this._filteredReviewsCacheKey = '';
      this._filteredReviewsCacheValue = [];
    }

    getReviewMedia(review) {
      if (Array.isArray(review?.__f1genzappReviewMedia)) {
        return review.__f1genzappReviewMedia;
      }
      return collectReviewMedia(review, this.config);
    }

    getPurchaseIdentity() {
      return {
        email: String(this.customerEmail || '').trim(),
        phone: normalizeCustomerPhone(this.customerPhone),
      };
    }

    async refreshPurchaseEligibility(options = {}) {
      if (!requiresPurchaseIdentity(this.config)) {
        this.state.purchaseEligibility = {
          loading: false,
          checked: true,
          eligible: true,
          reason: 'disabled',
        };
        return true;
      }

      const identity = this.getPurchaseIdentity();
      const shouldRender = options.render !== false && !this.state.loading;
      if (!identity.email && !identity.phone) {
        this.state.purchaseEligibility = {
          loading: false,
          checked: true,
          eligible: false,
          reason: 'missing_identity',
        };
        if (shouldRender) this.renderSummaryRegion();
        return false;
      }

      if (options.showLoader !== false) {
        this.state.purchaseEligibility = {
          ...this.state.purchaseEligibility,
          loading: true,
          checked: false,
          eligible: false,
          reason: '',
        };
        if (shouldRender) this.renderSummaryRegion();
      }

      try {
        const result = await getPurchaseEligibility(
          this.apiUrl,
          this.storeDomain,
          this.productId,
          identity,
          { force: !!options.force },
        );
        this.state.purchaseEligibility = {
          loading: false,
          checked: true,
          eligible: !!result.eligible,
          reason: result.reason || (result.eligible ? 'eligible' : 'not_purchased'),
        };
        if (shouldRender) this.renderSummaryRegion();
        return !!result.eligible;
      } catch {
        this.state.purchaseEligibility = {
          loading: false,
          checked: true,
          eligible: false,
          reason: 'not_purchased',
        };
        if (shouldRender) this.renderSummaryRegion();
        return false;
      }
    }

    canOpenReviewForm() {
      if (this.shouldRequireLogin) return false;
      if (!requiresPurchaseIdentity(this.config)) return true;
      const eligibility = this.state.purchaseEligibility || {};
      return this.hasCustomerIdentity && eligibility.checked && eligibility.eligible;
    }

    renderWriteAction() {
      if (this.shouldRequireLogin) {
        return `<a class="f1genz-sapo-review-btn--write f1genz-sapo-review-btn--login" href="${ACCOUNT_LOGIN_URL}" title="Đăng nhập tại /account">Đăng nhập để đánh giá</a>`;
      }

      if (requiresPurchaseIdentity(this.config)) {
        if (!this.hasCustomerIdentity) {
          return '<div class="f1genz-sapo-review-purchase-note">Kh\u00f4ng l\u1ea5y \u0111\u01b0\u1ee3c Email/S\u0110T t\u1eeb t\u00e0i kho\u1ea3n. Vui l\u00f2ng c\u1eadp nh\u1eadt th\u00f4ng tin t\u00e0i kho\u1ea3n tr\u01b0\u1edbc khi \u0111\u00e1nh gi\u00e1.</div>';
        }
        const eligibility = this.state.purchaseEligibility || {};
        if (eligibility.loading || !eligibility.checked) {
          return '<div class="f1genz-sapo-review-purchase-note">Đang xác minh mua hàng…</div>';
        }
        if (!eligibility.eligible) {
          return '<div class="f1genz-sapo-review-purchase-note">Chỉ khách đã mua sản phẩm này mới có thể đánh giá.</div>';
        }
      }

      return '<button type="button" class="f1genz-sapo-review-btn--write" data-action="open-form">Viết đánh giá</button>';
    }

    ensureReviewShell() {
      if (this.querySelector('[data-f1genz-sapo-review-region="summary"]')) return;
      this.renderTemplate('<div class="f1genz-sapo-review-preview"><div data-f1genz-sapo-review-region="summary"></div><div data-f1genz-sapo-review-region="list"></div><div data-f1genz-sapo-review-region="modal"></div><div data-f1genz-sapo-review-region="lightbox"></div></div>');
    }

    updateReviewRegion(name, markup) {
      const node = this.querySelector(`[data-f1genz-sapo-review-region="${name}"]`);
      if (!node) return;
      const nextMarkup = markup || '';
      if (node.innerHTML !== nextMarkup) {
        node.innerHTML = nextMarkup;
      }
    }

    renderSummaryRegion() {
      this.renderReviewRegions({ summary: true, list: false, modal: false, lightbox: false });
    }

    renderListRegion() {
      this.renderReviewRegions({ summary: false, list: true, modal: false, lightbox: false });
    }

    renderModalRegion() {
      this.renderReviewRegions({ summary: false, list: false, modal: true, lightbox: false });
    }

    renderLightboxRegion() {
      this.renderReviewRegions({ summary: false, list: false, modal: false, lightbox: true });
    }

    renderReviewRegions(options = {}) {
      if (this.state.loading) {
        this.renderPlaceholder('\u0110ang t\u1ea3i \u0111\u00e1nh gi\u00e1…');
        return;
      }

      const hasShell = !!this.querySelector('[data-f1genz-sapo-review-region="summary"]');
      const {
        summary = true,
        list = true,
        modal = true,
        lightbox = true,
      } = options;

      this.ensureReviewShell();
      const renderSummary = !hasShell || summary;
      const renderList = !hasShell || list;
      const renderModal = !hasShell || modal;
      const renderLightbox = !hasShell || lightbox;
      if (renderSummary) this.updateReviewRegion('summary', this.renderSummary());
      if (renderList) {
        this.updateReviewRegion('list', this.renderReviewList());
        this.syncReviewContentToggles();
      }
      if (renderModal) this.updateReviewRegion('modal', this.renderReviewModal());
      if (renderLightbox) this.updateReviewRegion('lightbox', this.renderLightbox());
    }

    syncReviewContentToggles() {
      const buttons = this.querySelectorAll('[data-action="open-review-detail"]');
      buttons.forEach((button) => {
        const card = button.closest('.f1genz-sapo-review-card');
        const content = card ? card.querySelector('.f1genz-sapo-review-card__content') : null;
        if (!card || !content) {
          button.hidden = true;
          return;
        }
        button.hidden = content.scrollHeight <= content.clientHeight + 1;
      });
    }

    getReviewByKey(reviewKey) {
      if (!reviewKey) return null;
      const filtered = this.getFilteredReviews();
      const filteredReview = filtered.find((review, index) => getReviewKey(review, index) === reviewKey);
      if (filteredReview) return filteredReview;
      return this.state.reviews.find((review, index) => getReviewKey(review, index) === reviewKey) || null;
    }

    getFilteredReviews() {
      const cacheKey = [
        this.state.reviewsVersion,
        this.state.sortBy,
        this.state.filterStar,
        this.state.filterHasMedia ? 1 : 0,
      ].join(':');
      if (this._filteredReviewsCacheKey === cacheKey) {
        return this._filteredReviewsCacheValue;
      }

      let reviews = [...this.state.reviews].sort((left, right) => {
        if (left.pinned && !right.pinned) return -1;
        if (!left.pinned && right.pinned) return 1;
        if (this.state.sortBy === 'oldest') return Number(left.created_at || 0) - Number(right.created_at || 0);
        return Number(right.created_at || 0) - Number(left.created_at || 0);
      });

      if (this.state.filterStar) {
        reviews = reviews.filter((review) => Number(review.rating) === this.state.filterStar);
      }
      if (this.state.filterHasMedia) {
        reviews = reviews.filter((review) => review.__f1genzappReviewHasMedia);
      }
      this._filteredReviewsCacheKey = cacheKey;
      this._filteredReviewsCacheValue = reviews;
      return reviews;
    }

    handleClick(event) {
      const source = event.target;
      if (!(source instanceof Element)) return;
      if (source.classList.contains('f1genz-sapo-review-modal-overlay') && source.dataset.kind === 'f1genz-sapo-review-form') {
        this.closeForm();
        return;
      }
      if (source.classList.contains('f1genz-sapo-review-modal-overlay') && source.dataset.kind === 'f1genz-sapo-review-detail') {
        this.closeReviewDetail();
        return;
      }
      if (source.classList.contains('f1genz-sapo-review-lightbox') && source.dataset.kind === 'f1genz-sapo-review-lightbox') {
        this.closeLightbox();
        return;
      }
      const actionNode = source.closest('[data-action], [data-filter-star], [data-filter-media]');
      if (!actionNode) return;

      const filterStar = actionNode.getAttribute('data-filter-star');
      const filterMedia = actionNode.getAttribute('data-filter-media');
      if (filterStar !== null) {
        const star = Number.parseInt(filterStar, 10);
        this.state.filterStar = star === 0 || this.state.filterStar === star ? 0 : star;
        this.state.filterHasMedia = false;
        this.state.page = 1;
        this.renderReviewRegions({ summary: true, list: true, modal: false, lightbox: false });
        return;
      }
      if (filterMedia !== null) {
        this.state.filterHasMedia = !this.state.filterHasMedia;
        this.state.filterStar = 0;
        this.state.page = 1;
        this.renderReviewRegions({ summary: true, list: true, modal: false, lightbox: false });
        return;
      }

      const action = actionNode.getAttribute('data-action');
      if (action === 'open-form') {
        if (this.shouldRequireLogin) {
          window.location.href = ACCOUNT_LOGIN_URL;
          return;
        }
        if (requiresPurchaseIdentity(this.config) && !this.canOpenReviewForm()) {
          this.refreshPurchaseEligibility({ force: true });
          return;
        }
        this.openForm();
        return;
      }
      if (action === 'close-form') {
        this.closeForm();
        return;
      }
      if (action === 'open-review-detail') {
        const key = actionNode.getAttribute('data-review-key') || '';
        if (!key) return;
        this.state.reviewDetailKey = key;
        this.state.formOpen = false;
        this.renderModalRegion();
        return;
      }
      if (action === 'close-review-detail') {
        this.closeReviewDetail();
        return;
      }
      if (action === 'page-prev') {
        this.state.page = Math.max(1, this.state.page - 1);
        this.renderListRegion();
        return;
      }
      if (action === 'page-next') {
        this.state.page += 1;
        this.renderListRegion();
        return;
      }
      if (action === 'page-set') {
        this.state.page = Math.max(1, Number.parseInt(actionNode.getAttribute('data-page') || '1', 10));
        this.renderListRegion();
        return;
      }
      if (action === 'set-rating') {
        this.state.formRating = Number.parseInt(actionNode.getAttribute('data-rating') || '0', 10);
        this.renderModalRegion();
        return;
      }
      if (action === 'trigger-file') {
        const input = this.querySelector('#f1genz-sapo-review-input-media');
        if (input) input.click();
        return;
      }
      if (action === 'remove-file') {
        const index = Number.parseInt(actionNode.getAttribute('data-index') || '-1', 10);
        if (index >= 0) {
          this.state.formFiles.splice(index, 1);
          this.syncPreviewUrls(this.state.formFiles);
          this.renderModalRegion();
        }
        return;
      }
      if (action === 'submit-form') {
        this.submitForm();
        return;
      }
      if (action === 'open-media') {
        const reviewIndex = Number.parseInt(actionNode.getAttribute('data-review-index') || '-1', 10);
        const mediaIndex = Number.parseInt(actionNode.getAttribute('data-media-index') || '0', 10);
        const review = this.visibleReviews[reviewIndex];
        if (!review) return;
        const media = this.getReviewMedia(review);
        if (!media.length) return;
        this.state.lightboxOpen = true;
        this.state.lightboxItems = media;
        this.state.lightboxIndex = mediaIndex;
        this.renderLightboxRegion();
        return;
      }
      if (action === 'open-review-detail-media') {
        const review = this.getReviewByKey(this.state.reviewDetailKey);
        if (!review) return;
        const media = this.getReviewMedia(review);
        const mediaIndex = Number.parseInt(actionNode.getAttribute('data-media-index') || '0', 10);
        if (!media.length) return;
        this.state.lightboxOpen = true;
        this.state.lightboxItems = media;
        this.state.lightboxIndex = mediaIndex;
        this.renderLightboxRegion();
        return;
      }
      if (action === 'close-lightbox') {
        this.closeLightbox();
        return;
      }
      if (action === 'prev-lightbox') {
        this.state.lightboxIndex = (this.state.lightboxIndex - 1 + this.state.lightboxItems.length) % this.state.lightboxItems.length;
        this.renderLightboxRegion();
        return;
      }
      if (action === 'next-lightbox') {
        this.state.lightboxIndex = (this.state.lightboxIndex + 1) % this.state.lightboxItems.length;
        this.renderLightboxRegion();
      }
    }

    handleChange(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.matches('[data-action="sort"]')) {
        this.state.sortBy = target.value;
        this.state.page = 1;
        this.renderReviewRegions({ summary: true, list: true, modal: false, lightbox: false });
        return;
      }
      if (target.id === 'f1genz-sapo-review-input-media') {
        const nextFiles = Array.from(target.files || []);
        this.state.formError = '';
        target.value = '';

        const processFiles = async () => {
          for (const file of nextFiles) {
            if (this.state.formFiles.length >= MAX_MEDIA_FILES) {
              this.state.formError = `Chỉ được tải tối đa ${MAX_MEDIA_FILES} tệp.`;
              break;
            }

            const isVideo = String(file.type || '').startsWith('video/');
            let ready = file;

            if (!isVideo) {
              try {
                ready = await prepareImageForUpload(file);
              } catch (error) {
                this.state.formError = error instanceof Error && error.message
                  ? error.message
                  : 'Không xử lý được ảnh. Thử JPEG/PNG/WebP nhỏ hơn 5MB.';
                continue;
              }
            }

            const maxSize = isVideo ? VIDEO_MAX_SIZE : IMAGE_MAX_SIZE;
            if (ready.size > maxSize) {
              this.state.formError = `Mỗi ${isVideo ? 'video' : 'ảnh'} chỉ được tối đa ${isVideo ? '2MB' : '5MB'}.`;
              continue;
            }

            this.state.formFiles.push(ready);
          }

          this.syncPreviewUrls(this.state.formFiles);
          this.renderModalRegion();
        };

        processFiles();
      }
    }

    handleInput(event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target.id === 'f1genz-sapo-review-input-title') this.state.formDraft.title = target.value;
      if (target.id === 'f1genz-sapo-review-input-content') this.state.formDraft.content = target.value;
      if (target.id === 'f1genz-sapo-review-input-author') this.state.formDraft.author = target.value;
      if (target.id === 'f1genz-sapo-review-input-email') this.state.formDraft.email = target.value;
      if (target.id === 'f1genz-sapo-review-input-phone') this.state.formDraft.phone = target.value;
      if (target.id === 'f1genz-sapo-review-input-video-url') this.state.formDraft.videoUrl = target.value;
    }

    async openForm() {
      try {
        this.config = await getWidgetConfig(this.apiUrl, this.storeDomain, { force: true });
        this.applyTheme(this.config);
      } catch {
        this.config = normalizeWidgetConfig(this.config);
      }
      if (this.shouldRequireLogin) {
        window.location.href = ACCOUNT_LOGIN_URL;
        return;
      }
      if (requiresPurchaseIdentity(this.config)) {
        const eligible = await this.refreshPurchaseEligibility({ force: true });
        if (!eligible) return;
      }
      this.state.reviewDetailKey = '';
      this.state.formOpen = true;
      this.state.formRating = 0;
      this.state.formFiles = [];
      this.state.formDraft = {
        title: '',
        content: '',
        author: '',
        email: getFormEmailMode(this.config) !== 'hidden' ? this.getPurchaseIdentity().email : '',
        phone: getFormPhoneMode(this.config) !== 'hidden' ? this.getPurchaseIdentity().phone : '',
        videoUrl: '',
      };
      this.state.formSubmitting = false;
      this.state.formError = '';
      this.state.formSuccess = '';
      this.syncPreviewUrls([]);
      this.renderModalRegion();
    }

    closeForm() {
      this.state.formOpen = false;
      this.state.formRating = 0;
      this.state.formFiles = [];
      this.state.formDraft = { title: '', content: '', author: '', email: '', phone: '', videoUrl: '' };
      this.state.formSubmitting = false;
      this.state.formError = '';
      this.state.formSuccess = '';
      this.syncPreviewUrls([]);
      this.renderModalRegion();
    }

    closeLightbox() {
      this.state.lightboxOpen = false;
      this.state.lightboxItems = [];
      this.state.lightboxIndex = 0;
      this.renderLightboxRegion();
    }

    closeReviewDetail() {
      this.state.reviewDetailKey = '';
      this.renderModalRegion();
    }

    async submitForm() {
      const title = this.state.formDraft.title.trim();
      const content = this.state.formDraft.content.trim();
      const author = this.state.formDraft.author.trim();
      const email = this.state.formDraft.email.trim();
      const phone = this.state.formDraft.phone.trim();
      const rawVideoUrl = this.state.formDraft.videoUrl.trim();
      const videoUrl = normalizeVideoLink(rawVideoUrl);
      const purchaseIdentity = this.getPurchaseIdentity();
      const verificationEmail = email || purchaseIdentity.email;
      const verificationPhone = phone || purchaseIdentity.phone;

      if (this.shouldRequireLogin) {
        window.location.href = ACCOUNT_LOGIN_URL;
        return;
      }
      if (requiresPurchaseIdentity(this.config) && !this.canOpenReviewForm()) {
        const eligible = await this.refreshPurchaseEligibility({ force: true });
        if (!eligible) {
          this.state.formError = 'Chỉ khách đã mua sản phẩm này mới có thể đánh giá.';
          this.renderModalRegion();
          return;
        }
      }
      if (!this.state.formRating) {
        this.state.formError = 'Vui lòng chọn số sao đánh giá';
        this.renderModalRegion();
        return;
      }
      if (!author) {
        this.state.formError = 'Vui lòng nhập Họ Tên';
        this.renderModalRegion();
        return;
      }
      if (author.length < 2) {
        this.state.formError = 'Họ Tên phải có ít nhất 2 ký tự';
        this.renderModalRegion();
        return;
      }
      if (author.length > 100) {
        this.state.formError = 'Họ Tên tối đa 100 ký tự';
        this.renderModalRegion();
        return;
      }
      if (this.config.formTitleMode === 'required' && !title) {
        this.state.formError = 'Vui lòng nhập Tiêu đề';
        this.renderModalRegion();
        return;
      }
      if (title && title.length > 100) {
        this.state.formError = 'Tiêu đề tối đa 100 ký tự';
        this.renderModalRegion();
        return;
      }
      const formContentMode = getFormContentMode(this.config);
      if (formContentMode === 'required' && !content) {
        this.state.formError = 'Vui lòng nhập Nội dung đánh giá';
        this.renderModalRegion();
        return;
      }
      if (content && content.length > 2000) {
        this.state.formError = 'Nội dung tối đa 2000 ký tự';
        this.renderModalRegion();
        return;
      }
      const formEmailMode = getFormEmailMode(this.config);
      if (formEmailMode === 'required' && !email) {
        this.state.formError = 'Vui lòng nhập Email';
        this.renderModalRegion();
        return;
      }
      if (email && !isValidEmail(email)) {
        this.state.formError = 'Email không đúng định dạng';
        this.renderModalRegion();
        return;
      }
      if (email && email.length > 200) {
        this.state.formError = 'Email tối đa 200 ký tự';
        this.renderModalRegion();
        return;
      }
      const formPhoneMode = getFormPhoneMode(this.config);
      if (formPhoneMode === 'required' && !phone) {
        this.state.formError = 'Vui lòng nhập Số điện thoại';
        this.renderModalRegion();
        return;
      }
      if (phone && !isValidPhone(phone)) {
        this.state.formError = 'Số điện thoại không hợp lệ (VD: 0987123456 hoặc +84987123456)';
        this.renderModalRegion();
        return;
      }

      if (requiresPurchaseIdentity(this.config) && !verificationEmail && !verificationPhone) {
        this.state.formError = 'Vui l\u00f2ng nh\u1eadp Email ho\u1eb7c S\u1ed1 \u0111i\u1ec7n tho\u1ea1i \u0111\u1ec3 x\u00e1c minh mua h\u00e0ng';
        this.renderModalRegion();
        return;
      }
      if (rawVideoUrl && !videoUrl) {
        this.state.formError = 'Link video phải là liên kết HTTPS của YouTube hoặc Vimeo.';
        this.renderModalRegion();
        return;
      }
      if (this.state.formFiles.length + (videoUrl ? 1 : 0) > MAX_MEDIA_FILES) {
        this.state.formError = `Chỉ được tải tối đa ${MAX_MEDIA_FILES} media.`;
        this.renderModalRegion();
        return;
      }

      this.state.formSubmitting = true;
      this.state.formError = '';
      this.renderModalRegion();

      try {
        const uploads = this.state.formFiles.length
          ? await Promise.all(
              this.state.formFiles.map((file) => uploadPublicFile(this.apiUrl, this.storeDomain, this.productId, file)),
            )
          : [];
        const payload = { rating: this.state.formRating, author };
        if (this.config.formTitleMode !== 'hidden' && title) payload.title = title;
        if (formContentMode !== 'hidden' && content) payload.content = content;
        if (formEmailMode !== 'hidden' && email) payload.email = email;
        else if (requiresPurchaseIdentity(this.config) && purchaseIdentity.email) payload.email = purchaseIdentity.email;
        if (formPhoneMode !== 'hidden' && phone) payload.phone = phone;
        else if (requiresPurchaseIdentity(this.config) && purchaseIdentity.phone) payload.phone = purchaseIdentity.phone;
        const media = uploads.filter((item) => item && item.url);
        if (videoUrl) media.push({ url: videoUrl, type: 'video' });
        if (media.length) payload.media = media.slice(0, MAX_MEDIA_FILES);

        await fetchJSON(`${this.apiUrl}/api/public/reviews/${encodeURIComponent(this.productId)}`, this.storeDomain, {
          method: 'POST',
          body: payload,
        });
        clearReviewCache(this.apiUrl, this.storeDomain, this.productId);

        this.state.formSubmitting = false;
        this.state.formSuccess = 'Cảm ơn bạn đã đánh giá. Đánh giá đang chờ duyệt.';
        this.syncPreviewUrls([]);
        this.state.formFiles = [];
        this.state.formDraft = { title: '', content: '', author: '', email: '', phone: '', videoUrl: '' };
        this.renderModalRegion();
        await this.reloadData(false);
        window.setTimeout(() => this.closeForm(), 2500);
      } catch (error) {
        this.state.formSubmitting = false;
        this.state.formError = publicErrorMessage(error, 'Gửi thất bại. Vui lòng thử lại sau.');
        this.renderModalRegion();
      }
    }

    renderSummary() {
      const summary = this.state.summary || {};
      const distribution = summary.distribution || {};
      const showAll = !this.state.filterStar && !this.state.filterHasMedia;
      let bars = '';
      for (let star = 5; star >= 1; star -= 1) {
        const count = Number(distribution[star] || 0);
        const percent = summary.count ? ((count / summary.count) * 100).toFixed(1) : 0;
        bars += `<button type="button" class="f1genz-sapo-review-bar-row" data-filter-star="${star}" aria-label="Lọc ${star} sao"><span class="f1genz-sapo-review-bar-row__label">${star}<span style="color:var(--f1genz-sapo-review-star-color)">${renderStar(this.config, true, 11)}</span></span><span class="f1genz-sapo-review-bar-row__track"><span class="f1genz-sapo-review-bar-row__fill" style="width:${percent}%"></span></span><span class="f1genz-sapo-review-bar-row__count">${count}</span></button>`;
      }

      let filters = '';
      if (this.config.showFilter) {
        filters += `<div class="f1genz-sapo-review-controls__filters"><button class="f1genz-sapo-review-pill ${showAll ? 'f1genz-sapo-review-pill--active' : ''}" data-filter-star="0" data-filter-media="0">Tất cả</button>`;
        for (let star = 5; star >= 1; star -= 1) {
          filters += `<button class="f1genz-sapo-review-pill ${this.state.filterStar === star ? 'f1genz-sapo-review-pill--active' : ''}" data-filter-star="${star}">
            ${star}<span style="color:${this.state.filterStar === star ? '#fff' : 'var(--f1genz-sapo-review-star-color)'}">${renderStar(this.config, true, 11)}</span> (${Number(distribution[star] || 0)})
          </button>`;
        }
        filters += `<button class="f1genz-sapo-review-pill ${this.state.filterHasMedia ? 'f1genz-sapo-review-pill--active' : ''}" data-filter-media="1">Có hình ảnh</button></div>`;
      }

      const writeAction = this.renderWriteAction();
      return `<div class="f1genz-sapo-review-section">
        ${this.config.showTitle ? `<h2 class="f1genz-sapo-review-title">${escapeHTML(this.config.titleText)} (${Number(summary.count || 0)})</h2>` : ''}
        <div class="f1genz-sapo-review-summary"><div class="f1genz-sapo-review-summary__score"><span class="f1genz-sapo-review-summary__avg">${Number(summary.avg || 0).toFixed(1)}</span><div class="f1genz-sapo-review-summary__stars">${renderStars(this.config, summary.avg || 0, 16)}</div><span class="f1genz-sapo-review-summary__count">${Number(summary.count || 0)} đánh giá</span></div><div class="f1genz-sapo-review-summary__bars">${bars}</div></div>
      </div><div class="f1genz-sapo-review-controls">
        ${filters}
        <div class="f1genz-sapo-review-controls__actions">
          ${this.config.showSort ? `<select class="f1genz-sapo-review-select" data-action="sort" aria-label="Sắp xếp đánh giá"><option value="newest" ${this.state.sortBy === 'newest' ? 'selected' : ''}>Mới nhất</option><option value="oldest" ${this.state.sortBy === 'oldest' ? 'selected' : ''}>Cũ nhất</option></select>` : ''}
          ${writeAction}
        </div></div>`;
    }

    renderReviewList() {
      const filtered = this.getFilteredReviews();
      if (!filtered.length) {
        this.visibleReviews = [];
        return '<div class="f1genz-sapo-review-placeholder">Không có đánh giá nào phù hợp.</div>';
      }

      const pageSize = normalizePageSize(this.config.reviewItemsPerPage, 5);
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const currentPage = Math.min(this.state.page, totalPages);
      if (currentPage !== this.state.page) this.state.page = currentPage;
      const startIndex = (currentPage - 1) * pageSize;
      this.visibleReviews = filtered.slice(startIndex, startIndex + pageSize);
      const useGrid = this.config.reviewLayout === 'grid';
      const useMasonry = this.config.reviewLayout === 'masonry';
      const renderReviewCard = (review, reviewIndex) => {
        const media = this.getReviewMedia(review);
        const reviewKey = getReviewKey(review, startIndex + reviewIndex);
        const showContentToggle = (useGrid || useMasonry) && review.content;
        return `<article class="f1genz-sapo-review-card" data-review-key="${escapeHTML(reviewKey)}"><div class="f1genz-sapo-review-card__main"><div class="f1genz-sapo-review-card__top"><div class="f1genz-sapo-review-card__avatar" style="background:${avatarColor(review.author)}">${escapeHTML(initials(review.author))}</div><div class="f1genz-sapo-review-card__meta"><div class="f1genz-sapo-review-card__name-row"><span class="f1genz-sapo-review-card__author">${escapeHTML(review.author)}</span>
                  ${(this.config.showVerified && (this.config.showVerifiedAll || review.verified)) ? '<span class="f1genz-sapo-review-card__verified">Đã mua hàng</span>' : ''}
                  ${this.config.showDate ? `<span class="f1genz-sapo-review-card__date">${escapeHTML(timeAgo(review.created_at))}</span>` : ''}
                </div><div class="f1genz-sapo-review-card__stars">${renderStars(this.config, review.rating, 14)}</div></div></div>
            ${(this.config.showTitle && review.title) ? `<div class="f1genz-sapo-review-card__title">${escapeHTML(review.title)}</div>` : ''}
            ${review.content ? `<div class="f1genz-sapo-review-card__content">${escapeHTML(review.content).replace(/\n/g, '<br>')}</div>` : ''}
            ${showContentToggle ? `<button type="button" class="f1genz-sapo-review-card__toggle" data-action="open-review-detail" data-review-key="${escapeHTML(reviewKey)}" aria-haspopup="dialog" hidden>Xem thêm</button>` : ''}
          </div>
          ${((this.config.allowReply && review.reply) || media.length) ? `<div class="f1genz-sapo-review-card__footer">
            ${(this.config.allowReply && review.reply) ? `<div class="f1genz-sapo-review-card__reply"><div class="f1genz-sapo-review-card__reply-badge">${escapeHTML(this.config.replyBadgeText || 'Phản hồi từ Shop')}</div><div class="f1genz-sapo-review-card__reply-content">${formatSafeRichText(review.reply)}</div></div>` : ''}
            ${media.length ? `<div class="f1genz-sapo-review-card__media">
              ${media.map((item, mediaIndex) => `<button type="button" class="f1genz-sapo-review-card__media-item" data-action="open-media" data-review-index="${reviewIndex}" data-media-index="${mediaIndex}" aria-label="Mở ${item.type === 'video' ? 'video' : 'ảnh'} đánh giá ${mediaIndex + 1}">
                ${item.type === 'video' ? `<video src="${escapeHTML(item.src)}" muted playsinline></video>` : `<img src="${escapeHTML(item.src)}" loading="lazy" decoding="async" alt="">`}
              </button>`).join('')}
            </div>` : ''}
          </div>` : ''}
        </article>`;
      };
      let content = '';
      if (useMasonry) {
        const columnCount = this._lastMasonryColumns;
        const columns = splitIntoMasonryColumns(
          this.visibleReviews.map((review, reviewIndex) => ({ review, reviewIndex })),
          columnCount,
        );
        content += `<div class="f1genz-sapo-review-masonry" style="--f1genz-sapo-review-masonry-columns:${columnCount}">`;
        columns.forEach((column) => {
          content += '<div class="f1genz-sapo-review-masonry__column">';
          column.forEach(({ review, reviewIndex }) => {
            content += renderReviewCard(review, reviewIndex);
          });
          content += '</div>';
        });
        content += '</div>';
      } else {
        if (useGrid) content += '<div class="f1genz-sapo-review-grid">';
        this.visibleReviews.forEach((review, reviewIndex) => {
          content += renderReviewCard(review, reviewIndex);
        });
        if (useGrid) content += '</div>';
      }
      content += renderPagination(currentPage, totalPages);
      return content;
    }

    renderReviewModal() {
      return `${this.renderReviewDetailModal()}${this.renderFormModal()}`;
    }

    renderReviewDetailModal() {
      const review = this.getReviewByKey(this.state.reviewDetailKey);
      if (!review) return '';
      const media = this.getReviewMedia(review);
      return `<div class="f1genz-sapo-review-modal-overlay" data-kind="f1genz-sapo-review-detail"><div class="f1genz-sapo-review-modal-box f1genz-sapo-review-detail-modal" role="dialog" aria-modal="true" aria-labelledby="${this._reviewDetailTitleId}"><div class="f1genz-sapo-review-modal-header"><h3 class="f1genz-sapo-review-modal-title" id="${this._reviewDetailTitleId}">Chi tiết đánh giá</h3><button type="button" class="f1genz-sapo-review-modal-close" data-action="close-review-detail" aria-label="Đóng">✕</button></div><div class="f1genz-sapo-review-modal-body"><div class="f1genz-sapo-review-detail"><div class="f1genz-sapo-review-detail__top"><div class="f1genz-sapo-review-card__avatar" style="background:${avatarColor(review.author)}">${escapeHTML(initials(review.author))}</div><div class="f1genz-sapo-review-card__meta"><div class="f1genz-sapo-review-card__name-row"><span class="f1genz-sapo-review-card__author">${escapeHTML(review.author)}</span>
                    ${(this.config.showVerified && (this.config.showVerifiedAll || review.verified)) ? '<span class="f1genz-sapo-review-card__verified">Đã mua hàng</span>' : ''}
                    ${this.config.showDate ? `<span class="f1genz-sapo-review-card__date">${escapeHTML(timeAgo(review.created_at))}</span>` : ''}
                  </div><div class="f1genz-sapo-review-card__stars">${renderStars(this.config, review.rating, 14)}</div>
                </div></div>
              ${(this.config.showTitle && review.title) ? `<div class="f1genz-sapo-review-detail__title">${escapeHTML(review.title)}</div>` : ''}
              ${review.content ? `<div class="f1genz-sapo-review-detail__content">${escapeHTML(review.content).replace(/\n/g, '<br>')}</div>` : ''}
              ${(this.config.allowReply && review.reply) ? `<div class="f1genz-sapo-review-card__reply"><div class="f1genz-sapo-review-card__reply-badge">${escapeHTML(this.config.replyBadgeText || 'Phản hồi từ Shop')}</div><div class="f1genz-sapo-review-card__reply-content">${formatSafeRichText(review.reply)}</div></div>` : ''}
              ${media.length ? `<div class="f1genz-sapo-review-card__media">
                ${media.map((item, mediaIndex) => `<button type="button" class="f1genz-sapo-review-card__media-item" data-action="open-review-detail-media" data-media-index="${mediaIndex}" aria-label="Mở ${item.type === 'video' ? 'video' : 'ảnh'} đánh giá ${mediaIndex + 1}">
                  ${item.type === 'video' ? `<video src="${escapeHTML(item.src)}" muted playsinline></video>` : `<img src="${escapeHTML(item.src)}" loading="lazy" decoding="async" alt="">`}
                </button>`).join('')}
              </div>` : ''}
            </div></div></div></div>`;
    }

    renderFormModal() {
      if (!this.state.formOpen) return '';
      if (this.state.formSuccess) {
        return `<div class="f1genz-sapo-review-modal-overlay" data-kind="f1genz-sapo-review-form"><div class="f1genz-sapo-review-modal-box"><div class="f1genz-sapo-review-modal-body"><div class="f1genz-sapo-review-placeholder" role="status">${escapeHTML(this.state.formSuccess)}</div></div></div></div>`;
      }

      const accept = [];
      if (this.config.allowImage) accept.push('image/jpeg,image/png,image/webp');
      if (this.config.allowVideo) accept.push('video/mp4');
      const draft = this.state.formDraft;
      const formEmailMode = getFormEmailMode(this.config);
      const formPhoneMode = getFormPhoneMode(this.config);

      return `<div class="f1genz-sapo-review-modal-overlay" data-kind="f1genz-sapo-review-form"><div class="f1genz-sapo-review-modal-box" role="dialog" aria-modal="true" aria-labelledby="${this._formTitleId}"><div class="f1genz-sapo-review-modal-header"><h3 class="f1genz-sapo-review-modal-title" id="${this._formTitleId}">Viết đánh giá</h3><button type="button" class="f1genz-sapo-review-modal-close" data-action="close-form" aria-label="Đóng">✕</button></div><div class="f1genz-sapo-review-modal-body">
            ${this.state.formError ? `<div class="f1genz-sapo-review-alert" role="alert">${escapeHTML(this.state.formError)}</div>` : ''}
            <div class="f1genz-sapo-review-form-group"><label class="f1genz-sapo-review-form-label">Điểm số *</label><div class="f1genz-sapo-review-modal-stars">
                ${[1, 2, 3, 4, 5].map((rating) => `<button type="button" class="f1genz-sapo-review-modal-star" data-action="set-rating" data-rating="${rating}" aria-label="${rating} sao">${renderStar(this.config, rating <= this.state.formRating, 32)}</button>`).join('')}
              </div></div>
            ${this.config.formTitleMode !== 'hidden' ? `<div class="f1genz-sapo-review-form-group"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-title">Tiêu đề${this.config.formTitleMode === 'required' ? ' *' : ''}</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-title" name="title" maxlength="100" placeholder="Tóm tắt đánh giá…" value="${escapeHTML(draft.title)}"></div>` : ''}
            ${getFormContentMode(this.config) !== 'hidden' ? `<div class="f1genz-sapo-review-form-group"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-content">Nội dung${getFormContentMode(this.config) === 'required' ? ' *' : ''}</label><textarea class="f1genz-sapo-review-textarea" id="f1genz-sapo-review-input-content" name="content" maxlength="2000" placeholder="Chia sẻ cảm nhận của bạn về sản phẩm này…">${escapeHTML(draft.content)}</textarea></div>` : ''}
            <div class="f1genz-sapo-review-modal-row"><div class="f1genz-sapo-review-form-group" style="flex:1"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-author">Họ Tên *</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-author" name="author" autocomplete="name" maxlength="100" placeholder="Nguyễn Văn A" value="${escapeHTML(draft.author)}"></div>
              ${formEmailMode !== 'hidden' ? `<div class="f1genz-sapo-review-form-group" style="flex:1"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-email">Email${formEmailMode === 'required' ? ' *' : ''}</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-email" name="email" autocomplete="email" spellcheck="false" maxlength="200" type="email" placeholder="email@gmail.com" value="${escapeHTML(draft.email)}"></div>` : ''}
            </div>
            ${formPhoneMode !== 'hidden' ? `<div class="f1genz-sapo-review-form-group"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-phone">Số điện thoại${formPhoneMode === 'required' ? ' *' : ''}</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-phone" name="phone" autocomplete="tel" inputmode="tel" maxlength="20" placeholder="0987123456" value="${escapeHTML(draft.phone)}"></div>` : ''}
            ${requiresPurchaseIdentity(this.config) ? `<div class="f1genz-sapo-review-form-hint">Ch\u1ec9 kh\u00e1ch \u0111\u00e3 mua s\u1ea3n ph\u1ea9m m\u1edbi c\u00f3 th\u1ec3 g\u1eedi \u0111\u00e1nh gi\u00e1. App s\u1ebd x\u00e1c minh b\u1eb1ng Email ho\u1eb7c S\u1ed1 \u0111i\u1ec7n tho\u1ea1i.</div>` : ''}
            ${this.config.allowVideo ? `<div class="f1genz-sapo-review-form-group f1genz-sapo-review-video-link"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-video-url">Link YouTube/Vimeo</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-video-url" name="videoUrl" inputmode="url" spellcheck="false" maxlength="2000" placeholder="https://youtube.com/watch?v=... hoặc https://vimeo.com/..." value="${escapeHTML(draft.videoUrl)}"><div class="f1genz-sapo-review-form-hint">Dán link HTTPS nếu không upload video file.</div></div>` : ''}
            ${(this.config.allowImage || this.config.allowVideo) ? `<div class="f1genz-sapo-review-form-group"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-media">Đính kèm ${this.config.allowImage && this.config.allowVideo ? 'Ảnh/Video' : this.config.allowImage ? 'Ảnh' : 'Video'}</label><div class="f1genz-sapo-review-form-hint">Tối đa 5 tệp. Ảnh tối đa 5MB (tự nén khi cần), video tối đa 2MB.</div><div class="f1genz-sapo-review-file-wrap"><input id="f1genz-sapo-review-input-media" class="f1genz-sapo-review-file-input" type="file" multiple accept="${accept.join(',')}" hidden tabindex="-1" aria-hidden="true" style="display:none!important;position:absolute;width:0;height:0;opacity:0;pointer-events:none"><label for="f1genz-sapo-review-input-media" class="f1genz-sapo-review-btn--outline f1genz-sapo-review-file-trigger">Chọn tệp…</label><span class="f1genz-sapo-review-file-note">${this.state.formFiles.length ? `${this.state.formFiles.length} tệp đã chọn` : 'Chưa chọn tệp nào'}</span></div>
              ${this.state.formFiles.length ? `<div class="f1genz-sapo-review-file-preview">
                ${this.state.formFiles.map((file, index) => `<div class="f1genz-sapo-review-file-thumb">
                  ${file.type.startsWith('video/') ? `<video src="${this.previewUrls[index] || ''}" muted></video>` : `<img src="${this.previewUrls[index] || ''}" alt="${escapeHTML(file.name)}" decoding="async">`}
                  <button type="button" class="f1genz-sapo-review-file-remove" data-action="remove-file" data-index="${index}" aria-label="Xóa tệp ${index + 1}">✕</button></div>`).join('')}
              </div>` : ''}
            </div>` : ''}
          </div><div class="f1genz-sapo-review-modal-footer"><button type="button" class="f1genz-sapo-review-btn" data-action="submit-form" ${this.state.formSubmitting ? 'disabled' : ''}>${this.state.formSubmitting ? 'Đang gửi…' : 'Gửi đánh giá'}</button><button type="button" class="f1genz-sapo-review-btn f1genz-sapo-review-btn--outline" data-action="close-form" ${this.state.formSubmitting ? 'disabled' : ''}>Hủy</button></div></div></div>`;
    }

    renderLightbox() {
      if (!this.state.lightboxOpen || !this.state.lightboxItems.length) return '';
      const item = this.state.lightboxItems[this.state.lightboxIndex];
      const videoEmbedUrl = item.type === 'video' ? getVideoEmbedUrl(item.src) : '';
      const videoMarkup = videoEmbedUrl
        ? `<iframe src="${escapeHTML(videoEmbedUrl)}" title="Video đánh giá" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
        : isDirectVideoUrl(item.src)
          ? `<video src="${escapeHTML(item.src)}" controls preload="metadata" playsinline></video>`
          : `<a class="f1genz-sapo-review-btn" href="${escapeHTML(item.src)}" target="_blank" rel="nofollow ugc noopener noreferrer">Mở video</a>`;
      return `<div class="f1genz-sapo-review-lightbox" data-action="close-lightbox" data-kind="f1genz-sapo-review-lightbox"><div class="f1genz-sapo-review-lightbox__inner"><button type="button" class="f1genz-sapo-review-lightbox__close" data-action="close-lightbox" aria-label="Đóng">✕</button>
          ${this.state.lightboxItems.length > 1 ? '<button type="button" class="f1genz-sapo-review-lightbox__nav f1genz-sapo-review-lightbox__prev" data-action="prev-lightbox" aria-label="Ảnh trước">‹</button>' : ''}
          ${item.type === 'video' ? videoMarkup : `<img src="${escapeHTML(item.src)}" decoding="async" alt="">`}
          ${this.state.lightboxItems.length > 1 ? '<button type="button" class="f1genz-sapo-review-lightbox__nav f1genz-sapo-review-lightbox__next" data-action="next-lightbox" aria-label="Ảnh sau">›</button>' : ''}
          ${this.state.lightboxItems.length > 1 ? `<div class="f1genz-sapo-review-lightbox__caption">${this.state.lightboxIndex + 1} / ${this.state.lightboxItems.length}</div>` : ''}
        </div></div>`;
    }

    render() {
      this.renderReviewRegions();
    }
  }

  class F1GQnaElement extends F1GBaseElement {
    constructor() {
      super();
      this._formTitleId = `f1genzapp-qna-form-title-${Math.random().toString(36).slice(2)}`;
      this.handleKeydown = (event) => {
        if (event.key === 'Escape' && this.state.formOpen) this.closeForm();
      };
      this.state = {
        loading: true,
        questions: [],
        summary: { total: 0, answered: 0 },
        page: 1,
        formOpen: false,
        formDraft: { author: '', email: '', question: '' },
        formSubmitting: false,
        formError: '',
        formSuccess: '',
      };
      this._eventsBound = false;
    }

    connectedCallback() {
      if (!this._eventsBound) {
        this.addEventListener('click', (event) => this.handleClick(event));
        this.addEventListener('input', (event) => this.handleInput(event));
        this._eventsBound = true;
      }
      window.addEventListener('keydown', this.handleKeydown);
      super.connectedCallback();
    }

    disconnectedCallback() {
      window.removeEventListener('keydown', this.handleKeydown);
    }

    async initialize() {
      if (!this.productId) {
        this.renderPlaceholder('');
        return;
      }
      this.render();
      await this.reloadData();
    }

    async reloadData(showLoader = true) {
      if (showLoader) {
        this.state.loading = true;
        this.render();
      }
      try {
        const questions = await getPublicQuestions(this.apiUrl, this.storeDomain, this.productId);
        const summary = calculateQnaSummaryFromQuestions(questions);
        this.state.loading = false;
        this.state.questions = Array.isArray(questions) ? questions : [];
        this.state.summary = summary || this.state.summary;
        this.render();
      } catch {
        this.state.loading = false;
        this.renderPlaceholder('');
      }
    }

    handleClick(event) {
      const source = event.target;
      if (!(source instanceof Element)) return;
      if (source.classList.contains('f1genz-sapo-review-modal-overlay') && source.dataset.kind === 'f1genz-sapo-review-qna-form') {
        this.closeForm();
        return;
      }
      const actionNode = source.closest('[data-action]');
      if (!actionNode) return;

      const action = actionNode.getAttribute('data-action');
      if (action === 'open-form') {
        if (this.shouldRequireLogin) {
          window.location.href = ACCOUNT_LOGIN_URL;
          return;
        }
        if (this.config.allowQnA !== false) this.openForm();
        return;
      }
      if (action === 'close-form') {
        this.closeForm();
        return;
      }
      if (action === 'page-prev') {
        this.state.page = Math.max(1, this.state.page - 1);
        this.render();
        return;
      }
      if (action === 'page-next') {
        this.state.page += 1;
        this.render();
        return;
      }
      if (action === 'page-set') {
        this.state.page = Math.max(1, Number.parseInt(actionNode.getAttribute('data-page') || '1', 10));
        this.render();
        return;
      }
      if (action === 'submit-form') {
        this.submitForm();
      }
    }

    async openForm() {
      if (this.shouldRequireLogin) {
        window.location.href = ACCOUNT_LOGIN_URL;
        return;
      }
      this.state.formOpen = true;
      this.state.formDraft = { author: '', email: '', question: '' };
      this.state.formSubmitting = false;
      this.state.formError = '';
      this.state.formSuccess = '';
      this.render();
    }

    closeForm() {
      this.state.formOpen = false;
      this.state.formDraft = { author: '', email: '', question: '' };
      this.state.formSubmitting = false;
      this.state.formError = '';
      this.state.formSuccess = '';
      this.render();
    }

    handleInput(event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target.id === 'f1genz-sapo-review-input-author') this.state.formDraft.author = target.value;
      if (target.id === 'f1genz-sapo-review-input-email') this.state.formDraft.email = target.value;
      if (target.id === 'f1genz-sapo-review-input-question') this.state.formDraft.question = target.value;
    }

    async submitForm() {
      if (this.shouldRequireLogin) {
        window.location.href = ACCOUNT_LOGIN_URL;
        return;
      }

      const author = this.state.formDraft.author.trim();
      const email = this.state.formDraft.email.trim();
      const question = this.state.formDraft.question.trim();

      if (!author) {
        this.state.formError = 'Vui lòng nhập Họ Tên';
        this.render();
        return;
      }
      if (author.length < 2) {
        this.state.formError = 'Họ Tên phải có ít nhất 2 ký tự';
        this.render();
        return;
      }
      if (author.length > 100) {
        this.state.formError = 'Họ Tên tối đa 100 ký tự';
        this.render();
        return;
      }
      if (!question) {
        this.state.formError = 'Vui lòng nhập câu hỏi';
        this.render();
        return;
      }
      if (question.length < 5) {
        this.state.formError = 'Câu hỏi phải có ít nhất 5 ký tự';
        this.render();
        return;
      }
      if (question.length > 1000) {
        this.state.formError = 'Câu hỏi tối đa 1000 ký tự';
        this.render();
        return;
      }
      if (email && !isValidEmail(email)) {
        this.state.formError = 'Email không đúng định dạng';
        this.render();
        return;
      }
      if (email && email.length > 200) {
        this.state.formError = 'Email tối đa 200 ký tự';
        this.render();
        return;
      }

      this.state.formSubmitting = true;
      this.state.formError = '';
      this.render();

      try {
        const payload = { author, question };
        if (email) payload.email = email;
        await fetchJSON(`${this.apiUrl}/api/public/qna/${encodeURIComponent(this.productId)}`, this.storeDomain, {
          method: 'POST',
          body: payload,
        });
        clearQnaCache(this.apiUrl, this.storeDomain, this.productId);
        this.state.formSubmitting = false;
        this.state.formSuccess = 'Câu hỏi đã được gửi. Chúng tôi sẽ phản hồi sớm nhất.';
        this.state.formDraft = { author: '', email: '', question: '' };
        this.render();
        await this.reloadData(false);
        window.setTimeout(() => this.closeForm(), 2500);
      } catch (error) {
        this.state.formSubmitting = false;
        this.state.formError = publicErrorMessage(error, 'Gửi thất bại. Vui lòng thử lại sau.');
        this.render();
      }
    }

    renderQuestions() {
      if (!this.state.questions.length) {
        return '<div class="f1genz-sapo-review-placeholder">Chưa có câu hỏi nào. Hãy là người đầu tiên.</div>';
      }

      const pageSize = normalizePageSize(this.config.qnaItemsPerPage, 5);
      const totalPages = Math.max(1, Math.ceil(this.state.questions.length / pageSize));
      const currentPage = Math.min(this.state.page, totalPages);
      if (currentPage !== this.state.page) this.state.page = currentPage;
      const startIndex = (currentPage - 1) * pageSize;
      const visible = this.state.questions.slice(startIndex, startIndex + pageSize);
      const grid = this.config.qnaDisplayMode === 'grid';
      let markup = grid ? '<div class="f1genz-sapo-review-qna-grid">' : '';

      visible.forEach((question) => {
        markup += `<article class="f1genz-sapo-review-qna-card"><div class="f1genz-sapo-review-qna-card__top"><div class="f1genz-sapo-review-qna-card__avatar" style="background:${avatarColor(question.author)}">${escapeHTML(initials(question.author))}</div><div class="f1genz-sapo-review-qna-card__meta"><span class="f1genz-sapo-review-qna-card__author">${escapeHTML(question.author)}</span>
              ${this.config.showDate ? `<span class="f1genz-sapo-review-qna-card__date">${escapeHTML(timeAgo(question.created_at))}</span>` : ''}
              <div class="f1genz-sapo-review-qna-card__question">${escapeHTML(question.question)}</div></div></div>
          ${question.answer ? `<div class="f1genz-sapo-review-qna-card__answer"><div class="f1genz-sapo-review-qna-card__answer-badge">${escapeHTML(question.answered_by || 'Shop')} trả lời</div><div class="f1genz-sapo-review-qna-card__answer-text">${formatSafeRichText(question.answer)}</div></div>` : '<div class="f1genz-sapo-review-qna-card__pending">Đang chờ trả lời…</div>'}
        </article>`;
      });

      if (grid) markup += '</div>';
      markup += renderPagination(currentPage, totalPages);
      return markup;
    }

    renderFormModal() {
      if (!this.state.formOpen) return '';
      if (this.state.formSuccess) {
        return `<div class="f1genz-sapo-review-modal-overlay" data-kind="f1genz-sapo-review-qna-form"><div class="f1genz-sapo-review-modal-box"><div class="f1genz-sapo-review-modal-body"><div class="f1genz-sapo-review-placeholder" role="status">${escapeHTML(this.state.formSuccess)}</div></div></div></div>`;
      }

      const draft = this.state.formDraft;

      return `<div class="f1genz-sapo-review-modal-overlay" data-kind="f1genz-sapo-review-qna-form"><div class="f1genz-sapo-review-modal-box" role="dialog" aria-modal="true" aria-labelledby="${this._formTitleId}"><div class="f1genz-sapo-review-modal-header"><h3 class="f1genz-sapo-review-modal-title" id="${this._formTitleId}">Đặt câu hỏi</h3><button type="button" class="f1genz-sapo-review-modal-close" data-action="close-form" aria-label="Đóng">✕</button></div><div class="f1genz-sapo-review-modal-body">
            ${this.state.formError ? `<div class="f1genz-sapo-review-alert" role="alert">${escapeHTML(this.state.formError)}</div>` : ''}
            <div class="f1genz-sapo-review-modal-row"><div class="f1genz-sapo-review-form-group" style="flex:1"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-author">Họ Tên *</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-author" name="author" autocomplete="name" maxlength="100" placeholder="Nguyễn Văn A" value="${escapeHTML(draft.author)}"></div><div class="f1genz-sapo-review-form-group" style="flex:1"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-email">Email</label><input class="f1genz-sapo-review-input" id="f1genz-sapo-review-input-email" name="email" autocomplete="email" spellcheck="false" maxlength="200" type="email" placeholder="email@gmail.com" value="${escapeHTML(draft.email)}"></div></div><div class="f1genz-sapo-review-form-group"><label class="f1genz-sapo-review-form-label" for="f1genz-sapo-review-input-question">Câu hỏi *</label><textarea class="f1genz-sapo-review-textarea" id="f1genz-sapo-review-input-question" name="question" maxlength="1000" placeholder="Bạn muốn hỏi gì về sản phẩm này?">${escapeHTML(draft.question)}</textarea></div></div><div class="f1genz-sapo-review-modal-footer"><button type="button" class="f1genz-sapo-review-btn" data-action="submit-form" ${this.state.formSubmitting ? 'disabled' : ''}>${this.state.formSubmitting ? 'Đang gửi…' : 'Gửi câu hỏi'}</button><button type="button" class="f1genz-sapo-review-btn f1genz-sapo-review-btn--outline" data-action="close-form" ${this.state.formSubmitting ? 'disabled' : ''}>Hủy</button></div></div></div>`;
    }

    render() {
      if (this.config.allowQnA === false) {
        this.renderTemplate('');
        return;
      }
      if (this.state.loading) {
        this.renderPlaceholder('\u0110ang t\u1ea3i h\u1ecfi \u0111\u00e1p…');
        return;
      }
      const askAction = this.shouldRequireLogin
        ? `<a class="f1genz-sapo-review-btn--ask f1genz-sapo-review-btn--login" href="${ACCOUNT_LOGIN_URL}" title="Đăng nhập tại /account">Đăng nhập để đặt câu hỏi</a>`
        : `<button type="button" class="f1genz-sapo-review-btn--ask" data-action="open-form">Đặt câu hỏi</button>`;
      this.renderTemplate(`<div class="f1genz-sapo-review-preview"><div class="f1genz-sapo-review-qna-header"><h3>Hỏi đáp (${Number(this.state.summary.total || 0)})</h3><div class="f1genz-sapo-review-qna-header__actions">
              ${askAction}
            </div></div>
          ${this.renderQuestions()}
          ${this.renderFormModal()}
        </div>`,
      );
    }
  }

  class F1GRatingBadgeElement extends F1GBaseElement {
    static get observedAttributes() {
      return ['avg-rating', 'review-count', 'storedomain', 'product-id'];
    }

    constructor() {
      super();
      this._ratingReady = false;
      this._summaryReloadVersion = 0;
    }

    readAttributeSummary() {
      const attrAvg = this.getAttribute('avg-rating');
      const attrCount = this.getAttribute('review-count');
      if (attrAvg === null || attrCount === null) return null;
      return {
        avg: Number.parseFloat(attrAvg || '0') || 0,
        count: Number.parseInt(attrCount || '0', 10) || 0,
      };
    }

    connectedCallback() {
      this.style.display = 'inline-flex';
      this.style.alignItems = 'center';
      this.style.gap = '4px';
      const attributeSummary = this.readAttributeSummary();
      if (attributeSummary) {
        this.state.summary = attributeSummary;
        this.render();
      }
      this._ratingReady = true;
      super.connectedCallback();
    }

    async initialize() {
      const attributeSummary = this.readAttributeSummary();
      if (attributeSummary) this.state.summary = attributeSummary;
      this.render();
      await this.reloadData();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (!this.isConnected || !this._ratingReady || oldValue === newValue) return;
      if (name === 'avg-rating' || name === 'review-count') {
        const attributeSummary = this.readAttributeSummary();
        if (attributeSummary) {
          this.state.summary = attributeSummary;
          this.render();
        }
      }
      this.reloadData();
    }

    async reloadData() {
      if (!this.productId || !this.storeDomain) return;
      const version = ++this._summaryReloadVersion;
      try {
        const summary = await getReviewSummary(this.apiUrl, this.storeDomain, this.productId);
        if (version !== this._summaryReloadVersion) return;
        this.state.summary = summary;
        this.render();
      } catch {
        if (version === this._summaryReloadVersion) this.render();
      }
    }

    render() {
      const summary = this.state.summary || {};
      const avgRating = Number.parseFloat(
        summary.avg ?? this.getAttribute('avg-rating') ?? '0',
      );
      const reviewCount = Number.parseInt(
        summary.count ?? this.getAttribute('review-count') ?? '0',
        10,
      );

      let stars = '';
      for (let index = 1; index <= 5; index += 1) {
        stars += renderStar(this.config, index <= Math.round(avgRating), 14);
      }

      const isEmpty = reviewCount <= 0 || avgRating <= 0;
      this.renderTemplate(`<span class="f1genz-sapo-review-rating-badge ${isEmpty ? 'f1genz-sapo-review-rating-badge--empty' : ''}"><span class="f1genz-sapo-review-rating-badge__stars" role="img" aria-label="${escapeHTML(avgRating.toFixed(1))} trên 5 sao">${stars}</span><span class="f1genz-sapo-review-rating-badge__count">(${reviewCount} đánh giá)</span></span>`,
      );
    }
  }

  function schemaAttribute(element, names, fallback = '') {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value && String(value).trim()) return String(value).trim();
    }
    return fallback;
  }

  function schemaList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function schemaDate(timestamp) {
    const date = new Date(Number(timestamp || Date.now()));
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString().slice(0, 10);
  }

  function schemaAvailability(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return 'https://schema.org/InStock';
    if (/^https:\/\/schema\.org\//i.test(normalized)) return normalized;
    const key = normalized.toLowerCase().replace(/[^a-z]/g, '');
    if (key === 'outofstock' || key === 'soldout') return 'https://schema.org/OutOfStock';
    if (key === 'preorder') return 'https://schema.org/PreOrder';
    if (key === 'discontinued') return 'https://schema.org/Discontinued';
    return 'https://schema.org/InStock';
  }

  function schemaPrice(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    let normalized = raw.replace(/[^\d.,-]/g, '');
    if (!normalized || normalized === '-' || normalized.includes('-')) return '';

    const lastComma = normalized.lastIndexOf(',');
    const lastDot = normalized.lastIndexOf('.');

    if (lastComma >= 0 && lastDot >= 0) {
      const decimalSeparator = lastComma > lastDot ? ',' : '.';
      const thousandSeparator = decimalSeparator === ',' ? '.' : ',';
      normalized = normalized
        .replace(new RegExp(`\\${thousandSeparator}`, 'g'), '')
        .replace(decimalSeparator, '.');
    } else if (lastComma >= 0) {
      const parts = normalized.split(',');
      if (parts.length > 2 || (parts.length > 1 && parts[parts.length - 1].length === 3)) {
        normalized = normalized.replace(/,/g, '');
      } else {
        normalized = normalized.replace(',', '.');
      }
    } else if (lastDot >= 0) {
      const parts = normalized.split('.');
      if (parts.length > 2 || (parts.length > 1 && parts[parts.length - 1].length === 3)) {
        normalized = normalized.replace(/\./g, '');
      }
    }

    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return '';
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric < 0) return '';
    const rounded = Math.round(numeric * 100) / 100;
    return Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function schemaInteger(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    }
    const match = String(value ?? '').match(/\d+/);
    if (!match) return 0;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  function schemaIdentifier(value, maxLength = 100) {
    const normalized = String(value || '')
      .replace(/[ -]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized || normalized.length > maxLength) return '';
    return normalized;
  }

  function schemaGtin(value) {
    const normalized = String(value || '').replace(/[^\d]/g, '');
    return /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(normalized) ? normalized : '';
  }

  function absoluteSchemaUrl(value, origin) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    if (normalized.startsWith('//')) return `https:${normalized}`;
    if (normalized.startsWith('/') && origin) return `${origin}${normalized}`;
    return /^https?:\/\//i.test(normalized) ? normalized : '';
  }

  function compactSchema(value) {
    if (Array.isArray(value)) {
      return value.map(compactSchema).filter((item) => item !== undefined);
    }
    if (value && typeof value === 'object') {
      const output = {};
      Object.entries(value).forEach(([key, item]) => {
        const cleaned = compactSchema(item);
        if (
          cleaned !== undefined &&
          cleaned !== '' &&
          !(Array.isArray(cleaned) && cleaned.length === 0)
        ) {
          output[key] = cleaned;
        }
      });
      return output;
    }
    return value === null ? undefined : value;
  }

  function pageMetaContent(property) {
    const node = document.querySelector(`meta[property="${property}"]`);
    return node ? node.getAttribute('content') || '' : '';
  }

  function readSchemaAttributes(element) {
    return {
      name: schemaAttribute(element, ['product-name', 'name']),
      url: schemaAttribute(element, ['product-url', 'url']),
      images: schemaAttribute(element, ['product-image', 'image', 'images']),
      brand: schemaAttribute(element, ['brand', 'brand-name']),
      price:
        schemaAttribute(element, ['price']) ||
        pageMetaContent('product:price:amount') ||
        pageMetaContent('og:price:amount'),
      currency: schemaAttribute(element, ['currency', 'price-currency'], pageMetaContent('og:price:currency') || 'VND'),
      sku: schemaAttribute(element, ['sku']),
      mpn: schemaAttribute(element, ['mpn']),
      gtin: schemaAttribute(element, ['gtin', 'gtin13', 'gtin12', 'gtin8', 'barcode']),
      description: schemaAttribute(element, ['description']),
      availability: element.getAttribute('availability'),
      maxReviews: element.getAttribute('max-reviews'),
    };
  }

  function buildProductSchema(attrs, reviews, summary, page) {
    const name = String(attrs.name || '').trim();
    if (!name) return null;

    const safeReviews = Array.isArray(reviews) ? reviews : [];
    const stats = summary && typeof summary === 'object' ? summary : {};
    const maxReviews = Math.max(0, Math.min(50, Number.parseInt(attrs.maxReviews || '20', 10) || 20));
    const productUrl = absoluteSchemaUrl(attrs.url, page.origin) || page.href;
    const canonicalUrl = absoluteSchemaUrl(page.canonicalHref, page.origin) || `${page.origin}${page.pathname}`;
    const productNodeId = `${canonicalUrl.split('?')[0].split('#')[0]}#product`;
    const images = schemaList(attrs.images)
      .map((image) => absoluteSchemaUrl(image, page.origin))
      .filter(Boolean);
    const price = schemaPrice(attrs.price);
    const currency = schemaIdentifier(attrs.currency || 'VND', 3).toUpperCase();
    const brandName = schemaIdentifier(attrs.brand, 100);
    const reviewCount = schemaInteger(stats.count);
    const ratingValue = Number(stats.avg || 0);
    const hasApprovedReviews = reviewCount > 0 && Number.isFinite(ratingValue) && ratingValue > 0;

    return compactSchema({
      '@context': 'https://schema.org/',
      '@type': 'Product',
      '@id': productNodeId,
      name,
      image: images.length ? images : undefined,
      description: schemaIdentifier(attrs.description, 5000),
      sku: schemaIdentifier(attrs.sku, 100),
      mpn: schemaIdentifier(attrs.mpn, 100),
      gtin: schemaGtin(attrs.gtin),
      brand: brandName ? { '@type': 'Brand', name: brandName } : undefined,
      offers: price
        ? {
            '@type': 'Offer',
            url: productUrl,
            priceCurrency: currency || 'VND',
            price,
            availability: schemaAvailability(attrs.availability),
          }
        : undefined,
      aggregateRating: hasApprovedReviews
        ? {
            '@type': 'AggregateRating',
            ratingValue: Math.round(Math.max(1, Math.min(5, ratingValue)) * 10) / 10,
            reviewCount,
            bestRating: 5,
            worstRating: 1,
          }
        : undefined,
      review: hasApprovedReviews && safeReviews.length > 0
        ? safeReviews.slice(0, maxReviews).map((review) =>
            compactSchema({
              '@type': 'Review',
              author: { '@type': 'Person', name: String(review.author || 'Customer').trim() },
              datePublished: schemaDate(review.created_at),
              reviewBody: String(review.content || review.title || '').trim(),
              name: review.title ? String(review.title).trim() : undefined,
              reviewRating: {
                '@type': 'Rating',
                ratingValue: Math.max(1, Math.min(5, Number(review.rating || 5))),
                bestRating: 5,
                worstRating: 1,
              },
            }),
          )
        : undefined,
    });
  }

  class F1GProductSchemaElement extends F1GBaseElement {
    async bootstrap() {
      if (!this.apiUrl || !this.storeDomain) return;
      await this.initialize();
    }

    async initialize() {
      if (!this.productId) {
        this.renderTemplate('');
        return;
      }

      try {
        const [reviews, remoteSummary] = await Promise.all([
          getPublicReviews(this.apiUrl, this.storeDomain, this.productId),
          getReviewSummary(this.apiUrl, this.storeDomain, this.productId).catch(() => null),
        ]);
        const safeReviews = Array.isArray(reviews) ? reviews : [];
        const summary = remoteSummary && typeof remoteSummary === 'object'
          ? remoteSummary
          : calculateReviewSummaryFromReviews(safeReviews);
        this.renderSchema(safeReviews, summary);
      } catch {
        this.renderSchema([], {});
      }
    }

    renderSchema(reviews, summary) {
      const canonicalLink = document.querySelector('link[rel="canonical"]');
      const schema = buildProductSchema(readSchemaAttributes(this), reviews, summary, {
        href: window.location.href,
        origin: window.location.origin,
        pathname: window.location.pathname,
        canonicalHref: canonicalLink ? canonicalLink.getAttribute('href') : '',
      });
      if (!schema) {
        this.renderTemplate('');
        return;
      }

      this.innerHTML = '';
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.textContent = JSON.stringify(schema);
      this.appendChild(script);
    }
  }

  class F1GReviewsWidgetElement extends F1GBaseElement {
    constructor() {
      super();
      this.state = { activeTab: 'reviews' };
      this._eventsBound = false;
      this._tabsId = `f1genz-sapo-review-tabs-${Math.random().toString(36).slice(2)}`;
    }

    connectedCallback() {
      if (!this._eventsBound) {
        this.addEventListener('click', (event) => this.handleClick(event));
        this.addEventListener('keydown', (event) => this.handleKeydown(event));
        this._eventsBound = true;
      }
      super.connectedCallback();
    }

    initialize() {
      this.render();
    }

    handleClick(event) {
      const source = event.target;
      if (!(source instanceof Element)) return;
      const tabNode = source.closest('[data-f1genzapp-section-tab]');
      if (!tabNode) return;
      const nextTab = tabNode.getAttribute('data-f1genzapp-section-tab');
      if (nextTab !== 'reviews' && nextTab !== 'qna') return;
      this.state.activeTab = nextTab;
      if (nextTab === 'qna') this.ensureQnaPanel();
      this.updateTabState();
    }

    handleKeydown(event) {
      const source = event.target;
      if (!(source instanceof Element)) return;
      if (!source.closest('[data-f1genzapp-section-tab]')) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      this.state.activeTab = this.state.activeTab === 'reviews' ? 'qna' : 'reviews';
      if (this.state.activeTab === 'qna') this.ensureQnaPanel();
      this.updateTabState();
      const nextButton = this.querySelector(`[data-f1genzapp-section-tab="${this.state.activeTab}"]`);
      if (nextButton instanceof HTMLElement) nextButton.focus();
    }

    getReviewPanelMarkup() {
      const storeDomain = this.getAttribute('storeDomain') || '';
      const productId = this.getAttribute('product-id') || '';
      const customerEmail = this.getAttribute('customer-email') || '';
      const customerPhone = this.getAttribute('customer-phone') || '';
      return `<f1genz-reviews-panel
        product-id="${escapeHTML(productId)}"
        storeDomain="${escapeHTML(storeDomain)}"
        customer-email="${escapeHTML(customerEmail)}"
        customer-phone="${escapeHTML(customerPhone)}"
      ></f1genz-reviews-panel>`;
    }

    getQnaPanelMarkup() {
      const storeDomain = this.getAttribute('storeDomain') || '';
      const productId = this.getAttribute('product-id') || '';
      const customerEmail = this.getAttribute('customer-email') || '';
      const customerPhone = this.getAttribute('customer-phone') || '';
      return `<f1genz-qna-panel
        product-id="${escapeHTML(productId)}"
        storeDomain="${escapeHTML(storeDomain)}"
        customer-email="${escapeHTML(customerEmail)}"
        customer-phone="${escapeHTML(customerPhone)}"
      ></f1genz-qna-panel>`;
    }

    ensureQnaPanel() {
      const panel = this.querySelector('[data-f1genzapp-section-panel="qna"]');
      if (!(panel instanceof HTMLElement)) return;
      if (panel.querySelector('f1genz-qna-panel')) return;
      panel.innerHTML = this.getQnaPanelMarkup();
    }

    updateTabState() {
      ['reviews', 'qna'].forEach((tab) => {
        const selected = this.state.activeTab === tab;
        const button = this.querySelector(`[data-f1genzapp-section-tab="${tab}"]`);
        const panel = this.querySelector(`[data-f1genzapp-section-panel="${tab}"]`);
        if (button) {
          button.classList.toggle('f1genz-sapo-review-section-tab--active', selected);
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
          button.setAttribute('tabindex', selected ? '0' : '-1');
        }
        if (panel instanceof HTMLElement) panel.hidden = !selected;
      });
    }

    render() {
      const storeDomain = this.getAttribute('storeDomain') || '';
      const productId = this.getAttribute('product-id') || '';
      const customerEmail = this.getAttribute('customer-email') || '';
      const customerPhone = this.getAttribute('customer-phone') || '';
      if (!storeDomain || !productId) {
        this.innerHTML = '';
        return;
      }

      const reviewPanel = this.getReviewPanelMarkup();

      if (this.config.allowQnA === false) {
        this.innerHTML = `<div class="f1genz-sapo-review-feedback-stack">${reviewPanel}</div>`;
        return;
      }

      if (this.config.reviewQnaDisplayMode === 'tabs') {
        const reviewsSelected = this.state.activeTab !== 'qna';
        this.state.activeTab = reviewsSelected ? 'reviews' : 'qna';
        const qnaPanel = reviewsSelected ? '' : this.getQnaPanelMarkup();
        this.innerHTML = `<div class="f1genz-sapo-review-feedback-stack f1genz-sapo-review-feedback-stack--tabs"><div class="f1genz-sapo-review-section-tabs" role="tablist" aria-label="Đánh giá và hỏi đáp"><button
              type="button"
              id="${this._tabsId}-reviews-tab"
              class="f1genz-sapo-review-section-tab ${reviewsSelected ? 'f1genz-sapo-review-section-tab--active' : ''}"
              data-f1genzapp-section-tab="reviews"
              role="tab"
              aria-selected="${reviewsSelected ? 'true' : 'false'}"
              aria-controls="${this._tabsId}-reviews-panel"
              tabindex="${reviewsSelected ? '0' : '-1'}"
            >Đánh giá</button><button
              type="button"
              id="${this._tabsId}-qna-tab"
              class="f1genz-sapo-review-section-tab ${reviewsSelected ? '' : 'f1genz-sapo-review-section-tab--active'}"
              data-f1genzapp-section-tab="qna"
              role="tab"
              aria-selected="${reviewsSelected ? 'false' : 'true'}"
              aria-controls="${this._tabsId}-qna-panel"
              tabindex="${reviewsSelected ? '-1' : '0'}"
            >Hỏi đáp</button></div><section
            id="${this._tabsId}-reviews-panel"
            class="f1genz-sapo-review-section-panel"
            data-f1genzapp-section-panel="reviews"
            role="tabpanel"
            aria-labelledby="${this._tabsId}-reviews-tab"
            ${reviewsSelected ? '' : 'hidden'}
          >${reviewPanel}</section><section
            id="${this._tabsId}-qna-panel"
            class="f1genz-sapo-review-section-panel"
            data-f1genzapp-section-panel="qna"
            role="tabpanel"
            aria-labelledby="${this._tabsId}-qna-tab"
            ${reviewsSelected ? 'hidden' : ''}
          >${qnaPanel}</section></div>`;
        return;
      }

      this.innerHTML = `
        <div class="f1genz-sapo-review-feedback-stack">
          ${reviewPanel}
          ${this.getQnaPanelMarkup()}
        </div>
      `;
    }
  }

  const QUICKVIEW_SELECTOR = [
    '#quick-view-product',
    '#quickview-modal',
    '[data-quickview]',
    '[data-quick-view]',
    '[id^="quickview"]',
    '[id^="quick-view"]',
    '[class~="quickview-product"]',
    '[class~="quick-view-product"]',
  ].join(', ');
  const F1GENZ_ELEMENT_SELECTOR =
    'f1genz-reviews-panel, f1genz-qna-panel, f1genz-reviews, f1genz-rating-badge, f1genz-product-schema';
  const F1GENZ_RUNTIME_OWNED_SELECTOR = '[data-f1genz-runtime-owned]';

  function normalizeNumericId(value) {
    const normalized = String(value || '').trim();
    return /^\d+$/.test(normalized) ? normalized : '';
  }

  function resolveQuickviewStoreDomain(options = {}) {
    const explicit = String(options.storeDomain || '').trim();
    if (explicit) return explicit;

    const runtimeConfig = readRuntimeConfigObject();
    const configured = String(
      runtimeConfig && (runtimeConfig.storeDomain || runtimeConfig.store) || '',
    ).trim();
    if (configured) return configured;

    const existing = document.querySelector(`${F1GENZ_ELEMENT_SELECTOR}[storeDomain]`);
    return existing ? String(existing.getAttribute('storeDomain') || '').trim() : '';
  }

  function findPageProductId() {
    const f1 = document.querySelector(
      'f1genz-rating-badge[product-id], f1genz-product-schema[product-id]',
    );
    if (f1) return normalizeNumericId(f1.getAttribute('product-id'));
    const dataPid = document.querySelector('[data-product-id]');
    if (dataPid) return normalizeNumericId(dataPid.getAttribute('data-product-id'));
    const nativeBadge = document.querySelector('.sapo-product-reviews-badge[data-id]');
    if (nativeBadge) return normalizeNumericId(nativeBadge.getAttribute('data-id'));
    return '';
  }

  function readDomPrice() {
    const priceEl = document.querySelector('[itemprop="price"]');
    if (priceEl) return String(priceEl.getAttribute('content') || priceEl.textContent || '').trim();
    const meta = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]');
    if (meta) return String(meta.getAttribute('content') || '').trim();
    return schemaPrice(document.querySelector('.product-price, .price')?.textContent || '');
  }

  function readDomProductContext() {
    const productId = findPageProductId();
    if (!productId) return null;

    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogImage = document.querySelector('meta[property="og:image"]');
    const ogUrl = document.querySelector('meta[property="og:url"]');
    const price = readDomPrice();

    return {
      productId,
      name: String(
        (ogTitle ? ogTitle.content : '') ||
          document.title || '',
      ).trim(),
      image: (ogImage ? ogImage.content : '') || '',
      url: (ogUrl ? ogUrl.content : '') || window.location.href,
      price: String(price || '').trim(),
      brand: '',
      sku: '',
      available: !document.querySelector('.sold-out, .outstock, [class*="sold-out"]'),
      description: '',
    };
  }

  function readProductContextFromPage() {
    const ogType = document.querySelector('meta[property="og:type"]');
    if (!/product/i.test(ogType ? ogType.getAttribute('content') || '' : '')) return null;
    return readDomProductContext();
  }

  let productSchemaMountStarted = false;
  function mountProductSchemaIfMissing() {
    if (productSchemaMountStarted) return;
    productSchemaMountStarted = true;
    mountProductSchema().catch(() => {});
  }

  async function mountProductSchema() {
    if (document.querySelector('f1genz-product-schema')) return;
    if (!resolveRuntimeApiUrl()) return;
    const config = readRuntimeConfigObject();
    if (config && config.autoProductSchema === false) return;
    try {
      const ssrScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < ssrScripts.length; i++) {
        const content = ssrScripts[i].textContent || '';
        if (content.includes('"@type"') && content.includes('"Product"') && content.includes('"aggregateRating"') && content.includes('"offers"')) {
          return;
        }
      }
    } catch {}
    const context = readProductContextFromPage();
    if (!context) return;
    const storeDomain = resolveQuickviewStoreDomain();
    if (!storeDomain) return;
    const schema = document.createElement('f1genz-product-schema');
    schema.setAttribute('storeDomain', storeDomain);
    schema.setAttribute('product-id', String(context.productId));
    if (context.name) schema.setAttribute('product-name', context.name);
    if (context.image) schema.setAttribute('product-image', context.image);
    if (context.url) schema.setAttribute('product-url', context.url);
    if (context.price) schema.setAttribute('price', context.price);
    if (context.brand) schema.setAttribute('brand', context.brand);
    if (context.sku) schema.setAttribute('sku', context.sku);
    if (context.available != null) {
      schema.setAttribute('availability', context.available ? 'InStock' : 'OutOfStock');
    }
    if (context.description) schema.setAttribute('description', context.description);
    (document.head || document.body).appendChild(schema);
  }

  function resolveProductIdFromModalContext(quickview) {
    const candidates = [];
    if (quickview.querySelectorAll) {
      quickview.querySelectorAll('[id]').forEach((element) => {
        const id = String(element.id || '');
        const match =
          /^product-(?:select-)?(\d+)$/.exec(id) ||
          /^product-select-(\d+)(?:-|$)/.exec(id);
        if (match) candidates.push(match[1]);
      });
      quickview.querySelectorAll('script').forEach((script) => {
        const text = String(script.textContent || '');
        const match =
          /(?:product_quickview|product_quick)\s*[=:]\s*\{[\s\S]*?\b(?:id|product_id)\s*:\s*(\d+)/.exec(
            text,
          );
        if (match) candidates.push(match[1]);
      });
    }
    [
      window.product_quickview,
      window.product_quick,
    ].forEach((value) => {
      if (value && typeof value === 'object') {
        const id = normalizeNumericId(value.id || value.product_id);
        if (id) candidates.push(id);
      }
    });
    return candidates.length ? candidates[0] : '';
  }

  function resolveQuickviewProductId(quickview, options = {}) {
    const explicit = normalizeNumericId(options.productId || options.productid);
    if (explicit) return explicit;

    const productNode = quickview.matches('[data-product-id], [data-productid]')
      ? quickview
      : quickview.querySelector('[data-product-id], [data-productid]');
    const fromData = productNode
      ? normalizeNumericId(
          productNode.getAttribute('data-product-id') ||
          productNode.getAttribute('data-productid'),
        )
      : '';
    if (fromData) return fromData;

    const fromContext = resolveProductIdFromModalContext(quickview);
    if (fromContext) return fromContext;
    return '';
  }

  function resolveQuickviewRoot(root) {
    if (root instanceof Element) {
      if (root.matches(QUICKVIEW_SELECTOR)) return root;
      return root.closest(QUICKVIEW_SELECTOR);
    }
    return null;
  }

  function mountQuickview(root, options = {}) {
    const quickview = resolveQuickviewRoot(root);
    if (!quickview) return null;

    const storeDomain = resolveQuickviewStoreDomain(options);
    if (!storeDomain) return null;

    const productId = resolveQuickviewProductId(quickview, options);
    if (!productId) return null;

    const existingBadges = quickview.querySelectorAll('f1genz-rating-badge');
    if (existingBadges.length) {
      existingBadges.forEach((badge) => {
        if (!String(badge.getAttribute('product-id') || '').trim()) {
          badge.setAttribute('product-id', productId);
        }
        if (!String(badge.getAttribute('storeDomain') || '').trim()) {
          badge.setAttribute('storeDomain', storeDomain);
        }
      });
      return existingBadges[0];
    }

    const badge = document.createElement('f1genz-rating-badge');
    badge.setAttribute('product-id', productId);
    badge.setAttribute('storeDomain', storeDomain);

    const nativeRating = quickview.querySelector('.sapo-product-reviews-badge');
    if (nativeRating) {
      nativeRating.setAttribute('data-f1genz-runtime-owned', 'quickview-rating');
      nativeRating.replaceChildren(badge);
      return badge;
    }

    const anchor = quickview.querySelector('.product-title, .product-price');
    if (!anchor || !anchor.parentNode) return null;
    const host = document.createElement('div');
    host.setAttribute('data-f1genz-runtime-owned', 'quickview-rating');
    host.appendChild(badge);
    anchor.insertAdjacentElement('afterend', host);
    return badge;
  }

  function collectQuickviews(root) {
    const quickviews = [];
    if (root instanceof Element) {
      const closest = resolveQuickviewRoot(root);
      if (closest) quickviews.push(closest);
    }
    if (root && typeof root.querySelectorAll === 'function') {
      root.querySelectorAll(QUICKVIEW_SELECTOR).forEach((quickview) => {
        if (!quickviews.includes(quickview)) quickviews.push(quickview);
      });
    }
    return quickviews;
  }

  function scan(root = document, options = {}) {
    const mounted = [];
    collectQuickviews(root).forEach((quickview) => {
      const badge = mountQuickview(quickview, options);
      if (badge) mounted.push(badge);
    });
    return mounted;
  }

  function isF1genzOwnedNode(node) {
    return node instanceof Element && Boolean(
      node.matches(F1GENZ_ELEMENT_SELECTOR) ||
      node.closest(`${F1GENZ_ELEMENT_SELECTOR}, ${F1GENZ_RUNTIME_OWNED_SELECTOR}`),
    );
  }

  function installDynamicContentObserver() {
    if (!document.body || window.__f1genzSapoReviewDynamicContentObserver) return;
    const pendingRoots = new Set();
    let scanFrame = 0;
    const scheduleScan = (root) => {
      if (!root || isF1genzOwnedNode(root)) return;
      pendingRoots.add(root);
      if (scanFrame) return;
      scanFrame = window.requestAnimationFrame(() => {
        scanFrame = 0;
        const roots = Array.from(pendingRoots);
        pendingRoots.clear();
        roots.forEach((pendingRoot) => scan(pendingRoot));
      });
    };

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.target instanceof Element &&
          mutation.target.closest(QUICKVIEW_SELECTOR)
        ) {
          scheduleScan(mutation.target);
        }
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) scheduleScan(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__f1genzSapoReviewDynamicContentObserver = observer;
    scan(document);
  }

  class F1GCuratedSliderElement extends F1GBaseElement {
    async initialize() {
      if (this.config.curatedSliderEnabled === false) {
        this.innerHTML = '';
        return;
      }
      if (!this.apiUrl || !this.storeDomain || !this.productId) {
        this.innerHTML = '';
        return;
      }
      const attributeCount = Number(this.getAttribute('count'));
      const count = Number.isFinite(attributeCount) && attributeCount > 0
        ? Math.max(5, Math.min(15, Math.trunc(attributeCount)))
        : Math.max(5, Math.min(15, Number(this.config.curatedSliderCount) || 15));
      try {
        const payload = await fetchJSON(
          `${this.apiUrl}/api/public/reviews/${encodeURIComponent(this.productId)}/slider?limit=${count}`,
          this.storeDomain,
        );
        const items = payload && Array.isArray(payload.items) ? payload.items : [];
        this.render(items);
      } catch {
        this.innerHTML = '';
      }
    }

    render(items) {
      if (!items.length) {
        this.innerHTML = '';
        return;
      }
      const cards = items.map((item) => {
        const media = typeof item.m === 'string' && /^https?:\/\//.test(item.m)
          ? `<img class="f1genz-sapo-review-slider__media" src="${escapeHTML(item.m)}" alt="" width="320" height="240" loading="lazy" decoding="async">`
          : '';
        const title = item.t ? `<p class="f1genz-sapo-review-slider__title">${escapeHTML(item.t)}</p>` : '';
        const verified = Number(item.v) === 1
          ? '<span class="f1genz-sapo-review-slider__verified">Đã mua hàng</span>'
          : '';
        return `<li class="f1genz-sapo-review-slider__item">${media}<div class="f1genz-sapo-review-slider__body"><div class="f1genz-sapo-review-slider__stars">${renderStars(this.config, Number(item.r) || 5, 14)}</div>${title}<p class="f1genz-sapo-review-slider__content">${escapeHTML(String(item.c || ''))}</p><div class="f1genz-sapo-review-slider__meta"><span class="f1genz-sapo-review-slider__author">${escapeHTML(String(item.a || 'Khách hàng'))}</span>${verified}</div></div></li>`;
      }).join('');
      this.innerHTML = `<section class="f1genz-sapo-review-slider" aria-label="Đánh giá nổi bật">
        <div class="f1genz-sapo-review-slider__head"><h3 class="f1genz-sapo-review-slider__heading">Đánh giá nổi bật</h3><div class="f1genz-sapo-review-slider__nav"><button type="button" class="f1genz-sapo-review-slider__arrow" data-slider-step="-1" aria-label="Đánh giá trước">‹</button><button type="button" class="f1genz-sapo-review-slider__arrow" data-slider-step="1" aria-label="Đánh giá sau">›</button></div></div>
        <ul class="f1genz-sapo-review-slider__track">${cards}</ul></section>`;
      const track = this.querySelector('.f1genz-sapo-review-slider__track');
      this.querySelectorAll('[data-slider-step]').forEach((button) => {
        button.addEventListener('click', () => {
          if (!(track instanceof HTMLElement)) return;
          const step = Number(button.getAttribute('data-slider-step')) || 1;
          const card = track.querySelector('.f1genz-sapo-review-slider__item');
          const width = card instanceof HTMLElement ? card.getBoundingClientRect().width + 12 : 300;
          track.scrollBy({ left: step * width, behavior: 'smooth' });
        });
      });
    }
  }

  if (!customElements.get('f1genz-reviews-panel')) {
    customElements.define('f1genz-reviews-panel', F1GReviewsElement);
  }

  if (!customElements.get('f1genz-qna-panel')) {
    customElements.define('f1genz-qna-panel', F1GQnaElement);
  }

  if (!customElements.get('f1genz-reviews')) {
    customElements.define('f1genz-reviews', F1GReviewsWidgetElement);
  }

  if (!customElements.get('f1genz-rating-badge')) {
    customElements.define('f1genz-rating-badge', F1GRatingBadgeElement);
  }

  if (!customElements.get('f1genz-product-schema')) {
    customElements.define('f1genz-product-schema', F1GProductSchemaElement);
  }

  if (!customElements.get('f1genz-curated-slider')) {
    customElements.define('f1genz-curated-slider', F1GCuratedSliderElement);
  }

  window.F1GENZStorefront = Object.assign(window.F1GENZStorefront || {}, {
    scan,
    mountQuickview,
    internals: {
      formatSafeRichText,
      buildProductSchema,
      getPublicReviews,
      getPublicQuestions,
      getWidgetConfig,
      defaultConfig: DEFAULT_CONFIG,
      prepareImageForUpload,
      normalizeVideoLink,
      limits: { IMAGE_MAX_SIZE, VIDEO_MAX_SIZE, IMAGE_SOFT_TARGET },
    },
  });

  if (document.body) {
    installDynamicContentObserver();
  } else {
    document.addEventListener('DOMContentLoaded', installDynamicContentObserver, { once: true });
  }

  mountProductSchemaIfMissing();
  document.addEventListener('DOMContentLoaded', mountProductSchemaIfMissing, { once: true });
})();
