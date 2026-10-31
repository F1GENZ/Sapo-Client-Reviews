const { spawn, spawnSync } = require("child_process");
const { mkdtempSync, rmSync, existsSync } = require("fs");
const os = require("os");
const path = require("path");

const { sleep, killTree, parseDotEnv, canConnect, randomSuffix, redact } = require("./util.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const DB_NAME_PATTERN = /^sapo_agent_e2e_[a-z0-9]+$/;

function requireFromRoot(id) {
  return require(require.resolve(id, { paths: [ROOT] }));
}

function resolveAdminDatabaseUrl() {
  const explicit = process.env.E2E_DB_ADMIN_URL;
  if (explicit) return explicit;
  const fromFile = parseDotEnv(path.join(ROOT, ".env")).DATABASE_URL;
  if (fromFile) return fromFile;
  throw new Error(
    "No Postgres admin connection: set E2E_DB_ADMIN_URL (a role that can CREATE DATABASE) or provide DATABASE_URL in the root .env.",
  );
}

function withDatabase(adminUrl, dbName) {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function createThrowawayDatabase() {
  const adminUrl = resolveAdminDatabaseUrl();
  const dbName = `sapo_agent_e2e_${randomSuffix(4)}`;
  if (!DB_NAME_PATTERN.test(dbName)) throw new Error(`refusing unsafe database name ${dbName}`);
  const { PrismaClient } = requireFromRoot("@prisma/client");
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (error) {
    await admin.$disconnect().catch(() => undefined);
    throw new Error(
      `Cannot create throwaway Postgres database (is Postgres running and is the role allowed to CREATE DATABASE?): ${redact(
        error && error.message ? error.message.split("\n").pop() : error,
        [adminUrl],
      )}`,
    );
  }
  const url = withDatabase(adminUrl, dbName);
  return {
    dbName,
    url,
    async drop() {
      if (!DB_NAME_PATTERN.test(dbName)) throw new Error(`refusing to drop ${dbName}`);
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.$disconnect();
    },
  };
}

function migrateDeploy(databaseUrl) {
  const prismaCli = require.resolve("prisma/build/index.js", { paths: [ROOT] });
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed (exit ${result.status}):\n${redact(`${result.stdout}\n${result.stderr}`, [databaseUrl])}`,
    );
  }
  return redact(result.stdout, [databaseUrl]).trim().split("\n").slice(-4).join("\n");
}

function connectPrisma(databaseUrl) {
  const { PrismaClient } = requireFromRoot("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function resolveStateBackend() {
  const host = process.env.E2E_REDIS_HOST || "127.0.0.1";
  const port = Number(process.env.E2E_REDIS_PORT || 6379);
  if (await canConnect(port, host)) {
    const Redis = requireFromRoot("ioredis");
    const client = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await client.connect();
      if ((await client.ping()) !== "PONG") throw new Error("PING did not answer PONG");
    } finally {
      client.disconnect();
    }
    const prefix = `sapo-e2e-${randomSuffix(4)}`;
    return {
      kind: "redis",
      host,
      port,
      prefix,
      async cleanup() {
        const cleaner = new Redis({ host, port, maxRetriesPerRequest: 1 });
        try {
          let cursor = "0";
          do {
            const [next, keys] = await cleaner.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
            cursor = next;
            if (keys.length) await cleaner.del(...keys);
          } while (cursor !== "0");
        } finally {
          cleaner.disconnect();
        }
      },
    };
  }
  if (process.env.E2E_ALLOW_MEMORY_STATE === "1") {
    console.warn(
      `WARNING: no Redis at ${host}:${port}; E2E_ALLOW_MEMORY_STATE=1 so the server runs on its in-process state fallback. This run does NOT exercise Redis.`,
    );
    return { kind: "in-process-memory", prefix: "sapo-e2e-memory", async cleanup() {} };
  }
  throw new Error(
    `Redis is required but nothing answers at ${host}:${port}. Start one (docker run -p 6379:6379 redis:7) or point E2E_REDIS_HOST/E2E_REDIS_PORT at it. ` +
      "To run knowingly against the server's in-process state fallback instead, set E2E_ALLOW_MEMORY_STATE=1.",
  );
}

function resolveMainPath() {
  const distDir = process.env.E2E_DIST_DIR ? path.resolve(ROOT, process.env.E2E_DIST_DIR) : path.join(ROOT, "dist");
  const mainPath = path.join(distDir, "main.js");
  if (!existsSync(mainPath)) {
    throw new Error(`Compiled entrypoint missing at ${mainPath}. Run npm run build first (or point E2E_DIST_DIR at a build output inside the repo).`);
  }
  return mainPath;
}

// cwd is an empty temp directory so the server's ./.env loader cannot pull real values in
function spawnServer({ stubPort, env }) {
  const mainPath = resolveMainPath();
  const cwd = mkdtempSync(path.join(os.tmpdir(), "sapo-e2e-"));
  const preload = path.join(__dirname, "sapo-fetch-redirect.cjs");
  let stdout = "";
  let stderr = "";
  const proc = spawn(process.execPath, ["--require", preload, mainPath], {
    cwd,
    env: { ...process.env, ...env, E2E_SAPO_STUB_PORT: String(stubPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => (stdout += chunk));
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const tail = () =>
    [`--- stderr ---`, stderr.split("\n").slice(-15).join("\n"), `--- stdout ---`, stdout.split("\n").slice(-15).join("\n")].join("\n");
  const cleanupDir = () => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* temp dir removal is best effort */
    }
  };
  return { proc, logs: () => ({ stdout, stderr }), tail, cleanupDir };
}

async function startServer({ port, stubPort, env, readyTimeoutMs = 60000 }) {
  const { proc, logs, tail, cleanupDir } = spawnServer({ stubPort, env });

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (proc.exitCode !== null) {
      cleanupDir();
      throw new Error(`server exited early with code ${proc.exitCode}\n${redact(tail(), [env.DATABASE_URL])}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/livez`);
      if (res.status < 500) break;
    } catch {
      /* still booting */
    }
    if (Date.now() > deadline) {
      killTree(proc);
      cleanupDir();
      throw new Error(`server did not answer /livez within ${readyTimeoutMs}ms\n${redact(tail(), [env.DATABASE_URL])}`);
    }
    await sleep(250);
  }

  return {
    proc,
    logs,
    async stop() {
      killTree(proc);
      for (let i = 0; i < 40 && proc.exitCode === null; i += 1) await sleep(100);
      cleanupDir();
    },
  };
}

async function bootExpectingRefusal({ stubPort, env, timeoutMs = 30000 }) {
  const { proc, logs, cleanupDir } = spawnServer({ stubPort, env });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, exitCode: null }), timeoutMs);
    proc.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ timedOut: false, exitCode });
    });
  });
  killTree(proc);
  const { stdout, stderr } = logs();
  cleanupDir();
  return { ...outcome, output: redact(`${stderr}\n${stdout}`, [env.DATABASE_URL, env.DIRECT_URL]) };
}

module.exports = {
  ROOT,
  createThrowawayDatabase,
  migrateDeploy,
  connectPrisma,
  resolveStateBackend,
  startServer,
  bootExpectingRefusal,
};
