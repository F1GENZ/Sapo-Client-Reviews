const AuthScreen = ({
  status = "loading",
  title = "Đang xác thực…",
  message = "Vui lòng chờ trong giây lát.",
  actionLabel,
  onAction,
  children,
}) => {
  const isLoading = status === "loading";

  return (
    <main className="f1g-auth-shell">
      <section
        className={`f1g-auth-panel f1g-auth-panel--${status}`}
        role={isLoading ? "status" : "alert"}
        aria-live={isLoading ? "polite" : "assertive"}
      >
        {isLoading ? (
          <div className="f1g-route-spinner" aria-hidden="true" />
        ) : (
          <div className="f1g-auth-mark" aria-hidden="true" />
        )}
        <h1>{title}</h1>
        {message ? <p>{message}</p> : null}
        {actionLabel && onAction ? (
          <button type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
        {children}
      </section>
    </main>
  );
};

export default AuthScreen;
