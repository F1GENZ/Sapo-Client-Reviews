import { useEffect } from "react";
import { App as AntdApp, message as staticMessage } from "antd";

const normalizeArgs = (contentOrOptions, maybeDuration) => {
  if (typeof contentOrOptions === "object" && contentOrOptions !== null && !Array.isArray(contentOrOptions)) {
    return contentOrOptions;
  }

  return {
    content: contentOrOptions,
    ...(maybeDuration !== undefined ? { duration: maybeDuration } : {}),
  };
};

const ERROR_DURATION_SECONDS = 6;

const createToastApi = (api) => ({
  open: (contentOrOptions) => api.open(normalizeArgs(contentOrOptions)),
  success: (contentOrOptions, maybeDuration) => api.success(normalizeArgs(contentOrOptions, maybeDuration)),
  error: (contentOrOptions, maybeDuration) => api.error(
    normalizeArgs(contentOrOptions, maybeDuration ?? ERROR_DURATION_SECONDS),
  ),
  warning: (contentOrOptions, maybeDuration) => api.warning(
    normalizeArgs(contentOrOptions, maybeDuration ?? ERROR_DURATION_SECONDS),
  ),
  info: (contentOrOptions, maybeDuration) => api.info(normalizeArgs(contentOrOptions, maybeDuration)),
  loading: (contentOrOptions, maybeDuration) => api.loading(normalizeArgs(contentOrOptions, maybeDuration)),
  destroy: (key) => api.destroy(key),
});

let sharedToastApi = createToastApi(staticMessage);

const setSharedToastApi = (api) => {
  sharedToastApi = createToastApi(api);
};

export const toast = {
  open: (...args) => sharedToastApi.open(...args),
  success: (...args) => sharedToastApi.success(...args),
  error: (...args) => sharedToastApi.error(...args),
  warning: (...args) => sharedToastApi.warning(...args),
  info: (...args) => sharedToastApi.info(...args),
  loading: (...args) => sharedToastApi.loading(...args),
  destroy: (...args) => sharedToastApi.destroy(...args),
};

const ToastBridge = ({ children }) => {
  const { message: messageApi } = AntdApp.useApp();

  useEffect(() => {
    setSharedToastApi(messageApi);

    return () => {
      setSharedToastApi(staticMessage);
    };
  }, [messageApi]);

  return children;
};

export const ToastProvider = ({ children }) => (
  <AntdApp message={{ maxCount: 3, duration: 2.5 }}>
    <ToastBridge>{children}</ToastBridge>
  </AntdApp>
);
