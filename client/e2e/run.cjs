const { spawnSync } = require("child_process");
const path = require("path");

const suites = ["journeys.cjs", "storefront-widget.cjs"];
let failed = 0;

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: "inherit", env: process.env });
  if (result.status !== 0) failed += 1;
}

console.log(`\n${failed ? "FAIL" : "OK"} client e2e: ${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
