const { spawn, spawnSync } = require("child_process");
const { createServer } = require("http");
const net = require("net");
const {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function AUTH_INIT(storeDomain) {
  if (window.sessionStorage.getItem("__e2e_seeded")) return;
  const token = "e2e-token";
  const store = (storage) => {
    storage.setItem("storeDomain", storeDomain);
    storage.setItem("auth_session_token", token);
    storage.setItem(`auth_session_token:${storeDomain}`, token);
    storage.setItem("auth_verified", "1");
    storage.setItem(`auth_verified:${storeDomain}`, "1");
  };
  store(window.localStorage);
  store(window.sessionStorage);
  window.sessionStorage.setItem("__e2e_seeded", "1");
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function spawnPreview(clientRoot, port) {
  const logPath = path.join(clientRoot, `e2e-preview-${port}-${process.pid}.log`);
  const log = openSync(logPath, "a");
  const proc =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`], {
          cwd: clientRoot,
          detached: true,
          stdio: ["ignore", log, log],
        })
      : spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
          cwd: clientRoot,
          detached: true,
          stdio: ["ignore", log, log],
        });
  return { proc, logPath, log };
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-proc.pid);
  } catch {
    proc.kill();
  }
}

async function waitForUrl(baseUrl, { timeout = 25000, proc } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`server exited early with code ${proc.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.status < 500) return;
    } catch {
      /* keep waiting */
    }
    await sleep(250);
  }
  throw new Error(`server did not accept requests within ${timeout}ms: ${baseUrl}`);
}

async function startStatic({ root, port, aliases = {} }) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
  };
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const aliased = aliases[pathname];
    const filePath = aliased || path.join(root, pathname === "/" ? "/index.html" : pathname);
    const inside = aliased || path.resolve(filePath).startsWith(path.resolve(root));
    if (!inside || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(filePath));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function mockApi(context, { resolve, fallback, state = {} } = {}) {
  state.requests = state.requests || [];
  return context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    let payload = null;
    try {
      payload = request.postDataJSON();
    } catch {
      payload = request.postData();
    }
    const record = {
      pathname,
      method,
      search: url.search,
      payload,
      headers: request.headers(),
      rawUrl: request.url(),
    };
    state.requests.push(record);
    const result = resolve ? await resolve(pathname, method, payload, state, record) : undefined;
    const decided = result || fallback || { status: 404, body: { message: `unmocked ${method} ${pathname}` } };
    if (decided.abort) {
      await route.abort(decided.abort);
      return;
    }
    await route.fulfill({
      status: decided.status ?? 200,
      contentType: "application/json",
      headers: decided.headers,
      body: JSON.stringify(decided.body ?? { data: {} }),
    });
  });
}

async function waitUntil(predicate, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

async function readJson(page, url) {
  return page.evaluate(async (target) => {
    try {
      const response = await fetch(target, { headers: { accept: "application/json" } });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) {
      return { status: 0, body: null, error: String(error) };
    }
  }, url);
}

function trackPageErrors(page) {
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return { errors, consoleErrors };
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      documentOverflow:
        Math.max(root.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1,
      scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
      viewport: window.innerWidth,
    };
  });
  if (overflow.documentOverflow) {
    throw new Error(
      `${label}: document overflows horizontally (${overflow.scrollWidth} > ${overflow.viewport})`,
    );
  }
  return overflow;
}

function artifactsDir(baseDir, runName) {
  const dir = path.join(baseDir, "artifacts", runName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function shot(page, dir, name) {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function writeJson(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

module.exports = {
  sleep,
  AUTH_INIT,
  isPortFree,
  spawnPreview,
  killTree,
  waitForUrl,
  startStatic,
  mockApi,
  waitUntil,
  readJson,
  trackPageErrors,
  assertNoHorizontalOverflow,
  artifactsDir,
  shot,
  writeJson,
  readFileSync,
  closeSync,
  unlinkSync,
};
