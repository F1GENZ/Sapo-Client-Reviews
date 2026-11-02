CREATE TABLE "outbound_webhook_endpoints" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "store_domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" JSONB NOT NULL,
    "secret_ciphertext" TEXT,
    "secret_iv" TEXT,
    "secret_tag" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbound_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "store_domain" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(3),
    "response_status" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbound_webhook_endpoints_store_domain_active_idx" ON "outbound_webhook_endpoints"("store_domain", "active");
CREATE INDEX "outbound_webhook_deliveries_status_next_attempt_at_idx" ON "outbound_webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "outbound_webhook_deliveries_endpoint_id_created_at_idx" ON "outbound_webhook_deliveries"("endpoint_id", "created_at");
CREATE INDEX "outbound_webhook_deliveries_store_domain_created_at_idx" ON "outbound_webhook_deliveries"("store_domain", "created_at");

ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "outbound_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
