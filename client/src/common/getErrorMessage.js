const normalizeMessage = (value) => {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length ? items.join(", ") : null;
  }

  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }

  return null;
};

export const getErrorMessage = (error, fallback = "Đã xảy ra lỗi") => {
  const backendMessage = normalizeMessage(error?.response?.data?.message);
  if (backendMessage) return backendMessage;

  const backendError = normalizeMessage(error?.response?.data?.error);
  if (backendError) return backendError;

  const directMessage = normalizeMessage(error?.message);
  if (directMessage && directMessage !== "Network Error") return directMessage;

  return fallback;
};