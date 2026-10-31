-- CreateIndex
CREATE INDEX IF NOT EXISTS "catalog_products_productId_idx" ON "catalog_products"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customer_purchases_order_id_idx" ON "customer_purchases"("order_id");
