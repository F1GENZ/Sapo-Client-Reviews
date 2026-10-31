import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(__dirname, "..");
const repoRoot = resolve(clientRoot, "..");
const distRoot = resolve(clientRoot, "dist");
const assetRoot = resolve(distRoot, "assets");

const KB = 1024;
const budgets = {
  initialJsGzip: 120 * KB,
  singleJsGzip: 190 * KB,
  storefrontJsGzip: 30 * KB,
  storefrontCssGzip: 8 * KB,
};

const gzipSize = (filePath) => gzipSync(readFileSync(filePath)).length;
const fmt = (bytes) => `${(bytes / KB).toFixed(1)} kB`;

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
};

const pass = (message) => {
  console.log(`OK ${message}`);
};

const noRootAntdFiles = [
  resolve(clientRoot, "src", "main.jsx"),
  resolve(clientRoot, "src", "App.jsx"),
  resolve(clientRoot, "src", "pages", "auth", "AuthScreen.jsx"),
  resolve(clientRoot, "src", "pages", "auth", "login", "index.jsx"),
];

for (const filePath of noRootAntdFiles) {
  const source = readFileSync(filePath, "utf8");
  if (/from\s+["']antd["']/.test(source)) {
    fail(`${filePath.replace(`${clientRoot}\\`, "").replace(`${clientRoot}/`, "")} imports antd in root/auth path`);
  }
}
pass("root/auth paths do not import antd");

if (!existsSync(distRoot)) {
  fail("client/dist is missing. Run npm run build first.");
  process.exit();
}

const indexHtmlPath = resolve(distRoot, "index.html");
const indexHtml = readFileSync(indexHtmlPath, "utf8");
const initialAssetMatches = [
  ...indexHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/assets\/([^"]+\.js)"/g),
];
const initialJsAssets = [...new Set(initialAssetMatches.map((match) => match[1]))];
const initialJsGzip = initialJsAssets.reduce(
  (total, asset) => total + gzipSize(resolve(assetRoot, asset)),
  0,
);

if (initialJsGzip > budgets.initialJsGzip) {
  fail(`initial JS gzip ${fmt(initialJsGzip)} > ${fmt(budgets.initialJsGzip)} (${initialJsAssets.join(", ")})`);
} else {
  pass(`initial JS gzip ${fmt(initialJsGzip)} <= ${fmt(budgets.initialJsGzip)}`);
}

let largestJsAsset = { name: "", gzip: 0, raw: 0 };
for (const asset of readdirSync(assetRoot).filter((name) => name.endsWith(".js"))) {
  const filePath = resolve(assetRoot, asset);
  const rawSize = statSync(filePath).size;
  const gzSize = gzipSize(filePath);
  if (gzSize > largestJsAsset.gzip) {
    largestJsAsset = { name: asset, gzip: gzSize, raw: rawSize };
  }
  if (gzSize > budgets.singleJsGzip) {
    fail(`${asset} gzip ${fmt(gzSize)} > ${fmt(budgets.singleJsGzip)} (raw ${fmt(rawSize)})`);
  }
}
pass(`largest JS gzip ${fmt(largestJsAsset.gzip)} <= ${fmt(budgets.singleJsGzip)} (${largestJsAsset.name})`);

const storefrontJs = resolve(repoRoot, "storefront", "snippets", "f1genz-storefront.js");
const storefrontCss = resolve(repoRoot, "storefront", "snippets", "f1genz-storefront.css");
const storefrontJsGzip = gzipSize(storefrontJs);
const storefrontCssGzip = gzipSize(storefrontCss);

if (storefrontJsGzip > budgets.storefrontJsGzip) {
  fail(`storefront JS gzip ${fmt(storefrontJsGzip)} > ${fmt(budgets.storefrontJsGzip)}`);
} else {
  pass(`storefront JS gzip ${fmt(storefrontJsGzip)} <= ${fmt(budgets.storefrontJsGzip)}`);
}

if (storefrontCssGzip > budgets.storefrontCssGzip) {
  fail(`storefront CSS gzip ${fmt(storefrontCssGzip)} > ${fmt(budgets.storefrontCssGzip)}`);
} else {
  pass(`storefront CSS gzip ${fmt(storefrontCssGzip)} <= ${fmt(budgets.storefrontCssGzip)}`);
}
