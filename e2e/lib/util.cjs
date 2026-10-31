const { spawnSync } = require("child_process");
const { readFileSync, existsSync } = require("fs");
const net = require("net");
const crypto = require("crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function parseDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = value;
  }
  return out;
}

function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

function canConnect(port, host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function randomSuffix(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && String(secret).length >= 4) out = out.split(String(secret)).join("[redacted]");
  }
  return out.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[redacted]@");
}

module.exports = { sleep, killTree, parseDotEnv, isPortFree, canConnect, randomSuffix, redact };
