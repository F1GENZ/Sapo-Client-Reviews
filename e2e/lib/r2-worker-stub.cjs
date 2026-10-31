const KEY_RE = /^reviews\/[a-z0-9.-]+\/\d{1,20}\/[A-Za-z0-9_-]{16,64}\.(?:jpg|png|webp|mp4)$/;

function createR2WorkerStub({ uploadSecret }) {
  const calls = [];
  const objects = new Map();
  let mode = "ok";

  const handle = (req, res) => {
    const url = new URL(req.url, "http://r2.local");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const token = String(req.headers["x-upload-token"] || "");
      calls.push({
        method: req.method,
        key,
        token,
        contentType: String(req.headers["content-type"] || ""),
        bytes: body.length,
      });
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (token !== uploadSecret) return reply(401, { error: "unauthorized" });

      if (req.method === "GET" && url.pathname === "/list") {
        const prefix = url.searchParams.get("prefix") || "";
        const list = [...objects.entries()]
          .filter(([objectKey]) => objectKey.startsWith(prefix))
          .map(([objectKey, value]) => ({ key: objectKey, uploaded: value.uploaded }));
        return reply(200, { objects: list, cursor: null });
      }

      if (req.method === "PUT") {
        if (mode === "reject") return reply(403, { error: "forbidden" });
        if (mode === "too_large") return reply(413, { error: "too large" });
        if (mode === "fail") return reply(500, { error: "storage failure" });
        if (!KEY_RE.test(key)) return reply(400, { error: "bad key" });
        objects.set(key, { contentType: String(req.headers["content-type"] || ""), body, uploaded: Date.now() });
        return reply(200, { ok: true, key });
      }

      if (req.method === "DELETE") {
        if (!KEY_RE.test(key)) return reply(400, { error: "bad key" });
        objects.delete(key);
        return reply(200, { ok: true });
      }

      return reply(404, { error: "not found" });
    });
  };

  return {
    calls,
    objects,
    handle,
    setMode: (next) => {
      mode = next;
    },
  };
}

module.exports = { createR2WorkerStub };
