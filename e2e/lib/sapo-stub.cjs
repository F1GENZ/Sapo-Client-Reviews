const { createServer } = require("http");

function createSapoStub({ clientId, clientSecret, fallback }) {
  const calls = [];
  const unexpected = [];
  const metafields = new Map();
  const webhooks = new Map();
  const catalogProducts = new Map();
  const scriptTags = new Map();
  const tokens = new Map();
  const revoked = new Set();
  let nextId = 9000;
  let codeSeq = 0;

  const bucket = (map, host) => {
    if (!map.has(host)) map.set(host, []);
    return map.get(host);
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-sapo-api-call-limit": "1/40",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

  const server = createServer(async (req, res) => {
    if (fallback && !req.headers["x-e2e-sapo-host"]) return fallback(req, res);
    const host = String(req.headers["x-e2e-sapo-host"] || "").toLowerCase();
    const url = new URL(req.url, "http://stub.local");
    const path = url.pathname;
    const raw = await readBody(req);
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const record = {
      host,
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      token: req.headers["x-sapo-access-token"] || null,
      body,
    };
    calls.push(record);

    if (!/^[a-z0-9-]+\.mysapo\.net$/.test(host)) {
      unexpected.push({ ...record, reason: "request did not target a *.mysapo.net host" });
      return json(res, 400, { error: "bad host" });
    }

    if (req.method === "POST" && path === "/admin/oauth/access_token") {
      if (!body || body.client_id !== clientId || body.client_secret !== clientSecret) {
        return json(res, 401, { error: "invalid_client" });
      }
      const match = /^e2e-code-([a-z0-9-]+)$/.exec(String(body.code || ""));
      if (!match) return json(res, 400, { error: "invalid_grant" });
      const token = `e2e-token-${host.split(".")[0]}-${++codeSeq}`;
      tokens.set(host, token);
      revoked.delete(host);
      return json(res, 200, { access_token: token, scope: "read_products,write_products" });
    }

    if (!path.startsWith("/admin/")) {
      unexpected.push({ ...record, reason: "outside /admin" });
      return json(res, 404, { error: "not found" });
    }

    const token = String(req.headers["x-sapo-access-token"] || "");
    if (revoked.has(host) || !token || token !== tokens.get(host)) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (req.method === "GET" && path === "/admin/store.json") {
      const shortName = host.split(".")[0];
      return json(res, 200, {
        store: {
          id: 1,
          name: `E2E ${shortName}`,
          domain: host,
          mysapo_domain: host,
          email: `owner+${shortName}@example.com`,
        },
      });
    }

    const productMetafields = /^\/admin\/products\/(\d+)\/metafields(?:\/(\d+))?\.json$/.exec(path);
    if (productMetafields) {
      const list = bucket(metafields, `${host}|product|${productMetafields[1]}`);
      if (req.method === "GET") return json(res, 200, { metafields: list });
      if (req.method === "POST") {
        const created = { id: ++nextId, ...(body && body.metafield) };
        list.push(created);
        return json(res, 201, { metafield: created });
      }
      if (req.method === "PUT") {
        const existing = list.find((item) => String(item.id) === productMetafields[2]);
        if (!existing) return json(res, 404, { error: "not found" });
        Object.assign(existing, body && body.metafield);
        return json(res, 200, { metafield: existing });
      }
    }

    if (path === "/admin/metafields.json" || /^\/admin\/metafields\/\d+\.json$/.test(path)) {
      const list = bucket(metafields, `${host}|shop`);
      if (req.method === "GET") return json(res, 200, { metafields: list });
      if (req.method === "POST") {
        const created = { id: ++nextId, ...(body && body.metafield) };
        list.push(created);
        return json(res, 201, { metafield: created });
      }
      if (req.method === "PUT") {
        const id = path.match(/(\d+)\.json$/)[1];
        const existing = list.find((item) => String(item.id) === id);
        if (!existing) return json(res, 404, { error: "not found" });
        Object.assign(existing, body && body.metafield);
        return json(res, 200, { metafield: existing });
      }
    }

    if (path === "/admin/webhooks.json") {
      const list = bucket(webhooks, host);
      if (req.method === "GET") return json(res, 200, { webhooks: list });
      if (req.method === "POST") {
        const created = { id: ++nextId, ...(body && body.webhook) };
        list.push(created);
        return json(res, 201, { webhook: created });
      }
    }

    const webhookById = /^\/admin\/webhooks\/(\d+)\.json$/.exec(path);
    if (webhookById && req.method === "DELETE") {
      const list = bucket(webhooks, host);
      const at = list.findIndex((item) => String(item.id) === webhookById[1]);
      if (at === -1) return json(res, 404, { error: "not found" });
      list.splice(at, 1);
      return json(res, 200, {});
    }

    if (path === "/admin/script_tags.json") {
      const list = bucket(scriptTags, host);
      if (req.method === "GET") return json(res, 200, { script_tags: list });
      if (req.method === "POST") {
        const created = { id: ++nextId, ...(body && body.script_tag) };
        list.push(created);
        return json(res, 201, { script_tag: created });
      }
    }

    const product = /^\/admin\/products\/(\d+)\.json$/.exec(path);
    if (req.method === "GET" && product) {
      return json(res, 200, {
        product: {
          id: Number(product[1]),
          title: `E2E product ${product[1]}`,
          handle: `e2e-product-${product[1]}`,
          images: [{ src: "https://cdn.example.com/e2e.jpg" }],
          vendor: "E2E",
          status: "active",
        },
      });
    }
    if (req.method === "GET" && path === "/admin/products.json") {
      const page = Number(url.searchParams.get("page") || 1);
      return json(res, 200, { products: page === 1 ? catalogProducts.get(host) || [] : [] });
    }
    if (req.method === "GET" && path === "/admin/products/count.json") {
      return json(res, 200, { count: (catalogProducts.get(host) || []).length });
    }
    if (req.method === "GET" && path === "/admin/orders.json") return json(res, 200, { orders: [] });

    unexpected.push({ ...record, reason: "no stub route" });
    return json(res, 404, { error: "no stub route" });
  });

  return {
    calls,
    unexpected,
    metafields,
    webhooks,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    revoke: (host) => revoked.add(host),
    callsFor: (host, predicate = () => true) => calls.filter((call) => call.host === host && predicate(call)),
    productMetafields: (host, productId) => metafields.get(`${host}|product|${productId}`) || [],
    setCatalogProducts: (host, products) => catalogProducts.set(host, products),
  };
}

module.exports = { createSapoStub };
