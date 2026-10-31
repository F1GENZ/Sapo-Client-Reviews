import { useEffect, useRef, useState } from "react";
import { authService } from "../../../common/AuthService";
import {
  completeHandoff,
  getAuthenticatedRedirect,
  navigateTopLevel,
  parseStoreDomainInput,
} from "../../../common/authFlow";
import {
  getActiveStoreDomain,
  getStoreDomain,
  isAuthVerified,
  syncAuthSession,
} from "../../../common/AuthStorage";
import AuthScreen from "../AuthScreen";

const PENDING_TIMEOUT_MS = 12000;

const NOTICES = {
  session_expired: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại bằng tên cửa hàng.",
  handoff_failed:
    "Không tạo được phiên đăng nhập. Vui lòng mở lại ứng dụng từ trang quản trị Sapo hoặc đăng nhập bằng tên cửa hàng.",
  launch_invalid:
    "Liên kết khởi chạy từ Sapo không hợp lệ hoặc đã hết hạn. Vui lòng mở lại ứng dụng từ trang quản trị Sapo hoặc đăng nhập bằng tên cửa hàng.",
  launch_failed:
    "Không xác thực được yêu cầu khởi chạy từ Sapo. Vui lòng thử lại hoặc đăng nhập bằng tên cửa hàng.",
  timeout: "Xác thực mất quá lâu. Vui lòng kiểm tra kết nối và thử lại.",
  blocked:
    "Không chuyển được sang trang xác thực của Sapo. Vui lòng thử lại hoặc mở ứng dụng từ trang quản trị Sapo.",
  unknown: "Không thể xác thực. Vui lòng thử lại.",
};

const getInitialNotice = (params) => {
  const code = params.get("error");
  if (!code) return "";
  return NOTICES[code] || NOTICES.unknown;
};

const getEntryErrorMessage = (error) => {
  const status = error?.response?.status;
  if (status === 400) {
    return "Tên cửa hàng không hợp lệ. Vui lòng nhập dạng ten-cua-hang hoặc ten-cua-hang.mysapo.net.";
  }
  if (status === 429) return "Bạn thao tác quá nhanh. Vui lòng đợi một lát rồi thử lại.";
  return "Không thể kết nối đến dịch vụ xác thực. Vui lòng thử lại.";
};

const Login = () => {
  const params = new URLSearchParams(window.location.search);
  const isLaunch = params.has("hmac");
  const [phase, setPhase] = useState(isLaunch ? "verifying" : "form");
  const [notice, setNotice] = useState(() => getInitialNotice(params));
  const [formError, setFormError] = useState("");
  const [storeInput, setStoreInput] = useState(
    () => params.get("store") || params.get("storeDomain") || getActiveStoreDomain() || "",
  );
  const startedRef = useRef(false);

  const backToForm = (nextNotice) => {
    setNotice(nextNotice);
    setPhase("form");
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (isLaunch) {
      // The raw query is forwarded untouched: the hmac signs it byte for byte.
      authService
        .verifyLaunchQuery(window.location.search)
        .then(async (body) => {
          if (!body?.handoffCode) throw new Error("Missing handoff code");
          const { storeDomain, redirectTo } = await completeHandoff(body.handoffCode);
          window.location.replace(getAuthenticatedRedirect(storeDomain, redirectTo));
        })
        .catch((error) => {
          backToForm(error?.status === 401 ? NOTICES.launch_invalid : NOTICES.launch_failed);
        });
      return;
    }

    if (!params.get("error")) {
      syncAuthSession();
      const storeDomain = getStoreDomain() || getActiveStoreDomain();
      if (storeDomain && isAuthVerified(storeDomain)) {
        window.location.replace(getAuthenticatedRedirect(storeDomain));
      }
    }
  }, []);

  useEffect(() => {
    if (phase === "form") return undefined;
    const timer = setTimeout(
      () => backToForm(phase === "redirecting" ? NOTICES.blocked : NOTICES.timeout),
      PENDING_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [phase]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const storeDomain = parseStoreDomainInput(storeInput);
    if (!storeDomain) {
      setFormError(
        "Tên cửa hàng không hợp lệ. Vui lòng nhập dạng ten-cua-hang hoặc ten-cua-hang.mysapo.net.",
      );
      return;
    }
    setFormError("");
    setPhase("redirecting");
    try {
      const { url } = await authService.entry(storeDomain);
      if (!url) throw new Error("Missing authorize URL");
      navigateTopLevel(url);
    } catch (error) {
      setFormError(getEntryErrorMessage(error));
      setPhase("form");
    }
  };

  if (phase === "verifying") {
    return <AuthScreen title="Đang xác thực…" message="Đang xác minh yêu cầu khởi chạy từ Sapo." />;
  }

  if (phase === "redirecting") {
    return <AuthScreen title="Đang chuyển đến Sapo…" message="Vui lòng chờ trong giây lát." />;
  }

  return (
    <AuthScreen
      status={notice ? "error" : "warning"}
      title={notice ? "Xác thực không thành công" : "Đăng nhập cửa hàng Sapo"}
      message={notice || "Nhập tên cửa hàng Sapo của bạn để tiếp tục."}
    >
      <form className="f1g-auth-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="f1g-store-domain">Tên cửa hàng</label>
        <input
          id="f1g-store-domain"
          name="storeDomain"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="ten-cua-hang.mysapo.net"
          value={storeInput}
          onChange={(event) => setStoreInput(event.target.value)}
          aria-invalid={formError ? "true" : undefined}
          aria-describedby={formError ? "f1g-store-domain-error" : undefined}
        />
        {formError ? (
          <p id="f1g-store-domain-error" className="f1g-auth-form__error" role="alert">
            {formError}
          </p>
        ) : null}
        <button type="submit">Tiếp tục</button>
      </form>
    </AuthScreen>
  );
};

export default Login;
