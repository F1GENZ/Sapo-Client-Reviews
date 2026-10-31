import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRISMA_DIR = join(__dirname, '..', 'prisma');
const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');

const modelBlock = (name: string): string => {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `model ${name} exists`);
  return match[0];
};

const migrationSql = (): string =>
  readdirSync(join(PRISMA_DIR, 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(join(PRISMA_DIR, 'migrations', entry.name, 'migration.sql'), 'utf8'))
    .join('\n');

test('cross-store ownership lookups have a leading-column index in the schema and in a migration', () => {
  assert.match(modelBlock('CustomerPurchase'), /@@index\(\[orderId\]\)/);
  assert.match(modelBlock('CatalogProduct'), /@@index\(\[productId\]\)/);

  const sql = migrationSql();
  assert.match(sql, /CREATE INDEX (IF NOT EXISTS )?"customer_purchases_order_id_idx" ON "customer_purchases"\("order_id"\)/);
  assert.match(sql, /CREATE INDEX (IF NOT EXISTS )?"catalog_products_productId_idx" ON "catalog_products"\("productId"\)/);
});

test('the webhook event lifecycle generation column exists in the schema and in a migration', () => {
  assert.match(modelBlock('WebhookEvent'), /lifecycleGeneration\s+Int\?/);
  assert.match(migrationSql(), /ALTER TABLE "WebhookEvent" ADD COLUMN (IF NOT EXISTS )?"lifecycleGeneration" INTEGER/);
});
