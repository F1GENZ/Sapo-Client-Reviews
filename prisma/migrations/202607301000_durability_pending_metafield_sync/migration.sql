-- Durable queue of products whose storefront rating metafields must be (re)written.
CREATE TABLE "metafield_sync_pending" (
    "id" TEXT NOT NULL,
    "store_domain" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metafield_sync_pending_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metafield_sync_pending_store_domain_product_id_key" ON "metafield_sync_pending"("store_domain", "product_id");

CREATE INDEX "metafield_sync_pending_next_attempt_at_idx" ON "metafield_sync_pending"("next_attempt_at");

-- Stalled `processing` webhook scan.
CREATE INDEX "WebhookEvent_status_updatedAt_idx" ON "WebhookEvent"("status", "updatedAt");
