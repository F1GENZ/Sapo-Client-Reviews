-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('trial', 'active', 'free', 'canceled', 'expired', 'needs_reinstall', 'declined', 'uninstalled');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'processing', 'processed', 'failed', 'ignored');

-- CreateEnum
CREATE TYPE "WebhookRegistrationStatus" AS ENUM ('not_configured', 'pending', 'registered', 'degraded', 'failed');

-- CreateEnum
CREATE TYPE "DomainKind" AS ENUM ('primary', 'mysapo', 'custom', 'alias');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "storeDomain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppInstall" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "storeDomain" TEXT NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'trial',
    "accessTokenCiphertext" TEXT,
    "accessTokenIv" TEXT,
    "accessTokenTag" TEXT,
    "featuresUnlocked" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lifecycleGeneration" INTEGER NOT NULL DEFAULT 0,
    "installedAt" TIMESTAMP(3),
    "uninstalledAt" TIMESTAMP(3),
    "dataPreserved" BOOLEAN NOT NULL DEFAULT true,
    "webhookRegistrationStatus" "WebhookRegistrationStatus" NOT NULL DEFAULT 'not_configured',
    "webhookRegisteredAt" TIMESTAMP(3),
    "webhookRegistrationError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppInstall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopDomain" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "storeDomain" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "kind" "DomainKind" NOT NULL DEFAULT 'alias',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tombstonedAt" TIMESTAMP(3),
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "correlationKey" TEXT NOT NULL,
    "storeDomain" TEXT,
    "domain" TEXT,
    "subscriptionId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'Free',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "providerEventId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "normalizedTopic" TEXT NOT NULL,
    "resolvedStoreDomain" TEXT,
    "resolvedDomain" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB,
    "headers" JSONB,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextRetryAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_products" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "handle" TEXT NOT NULL DEFAULT '',
    "image" TEXT,
    "vendor" TEXT,
    "product_type" TEXT,
    "tags" TEXT,
    "status" TEXT,
    "published" BOOLEAN,
    "deleted_at" BIGINT,
    "raw_payload" JSONB,
    "source" TEXT NOT NULL DEFAULT 'sapo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_purchases" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_code" TEXT,
    "email_hash" TEXT,
    "phone_hash" TEXT,
    "financial_status" TEXT,
    "fulfillment_status" TEXT,
    "cancelled_at" BIGINT,
    "refunded_at" BIGINT,
    "purchased_at" BIGINT NOT NULL,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "customer_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_products" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_title" TEXT,
    "product_name" TEXT,
    "product_handle" TEXT,
    "product_image" TEXT,
    "review_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "media" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "reply" TEXT,
    "replied_at" BIGINT,
    "source_raw_json" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "review_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qna_questions" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_title" TEXT,
    "product_name" TEXT,
    "product_handle" TEXT,
    "product_image" TEXT,
    "question_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "answer" TEXT,
    "answered_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answered_at" BIGINT,
    "source_raw_json" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "qna_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_storeDomain_key" ON "Shop"("storeDomain");

-- CreateIndex
CREATE INDEX "Shop_storeDomain_idx" ON "Shop"("storeDomain");

-- CreateIndex
CREATE UNIQUE INDEX "AppInstall_shopId_key" ON "AppInstall"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "AppInstall_storeDomain_key" ON "AppInstall"("storeDomain");

-- CreateIndex
CREATE INDEX "AppInstall_storeDomain_status_idx" ON "AppInstall"("storeDomain", "status");

-- CreateIndex
CREATE INDEX "AppInstall_status_idx" ON "AppInstall"("status");

-- CreateIndex
CREATE INDEX "AppInstall_lifecycleGeneration_idx" ON "AppInstall"("lifecycleGeneration");

-- CreateIndex
CREATE INDEX "ShopDomain_domain_idx" ON "ShopDomain"("domain");

-- CreateIndex
CREATE INDEX "ShopDomain_storeDomain_active_idx" ON "ShopDomain"("storeDomain", "active");

-- CreateIndex
CREATE INDEX "ShopDomain_shopId_active_idx" ON "ShopDomain"("shopId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionSnapshot_correlationKey_key" ON "SubscriptionSnapshot"("correlationKey");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_storeDomain_idx" ON "SubscriptionSnapshot"("storeDomain");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_domain_idx" ON "SubscriptionSnapshot"("domain");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_subscriptionId_idx" ON "SubscriptionSnapshot"("subscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_payloadHash_idx" ON "SubscriptionSnapshot"("payloadHash");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_status_syncedAt_idx" ON "SubscriptionSnapshot"("status", "syncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_idempotencyKey_key" ON "WebhookEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookEvent_providerEventId_idx" ON "WebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_topic_resolvedStoreDomain_payloadHash_idx" ON "WebhookEvent"("topic", "resolvedStoreDomain", "payloadHash");

-- CreateIndex
CREATE INDEX "WebhookEvent_topic_resolvedDomain_payloadHash_idx" ON "WebhookEvent"("topic", "resolvedDomain", "payloadHash");

-- CreateIndex
CREATE INDEX "WebhookEvent_resolvedStoreDomain_status_receivedAt_idx" ON "WebhookEvent"("resolvedStoreDomain", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_nextRetryAt_idx" ON "WebhookEvent"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "catalog_products_shopId_idx" ON "catalog_products"("shopId");

-- CreateIndex
CREATE INDEX "catalog_products_shopId_deleted_at_idx" ON "catalog_products"("shopId", "deleted_at");

-- CreateIndex
CREATE INDEX "catalog_products_updated_at_idx" ON "catalog_products"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_products_shopId_productId_key" ON "catalog_products"("shopId", "productId");

-- CreateIndex
CREATE INDEX "customer_purchases_shop_id_product_id_idx" ON "customer_purchases"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "customer_purchases_shop_id_email_hash_idx" ON "customer_purchases"("shop_id", "email_hash");

-- CreateIndex
CREATE INDEX "customer_purchases_shop_id_phone_hash_idx" ON "customer_purchases"("shop_id", "phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "customer_purchases_shop_id_product_id_order_id_key" ON "customer_purchases"("shop_id", "product_id", "order_id");

-- CreateIndex
CREATE INDEX "review_products_shop_id_idx" ON "review_products"("shop_id");

-- CreateIndex
CREATE INDEX "review_products_shop_id_product_id_idx" ON "review_products"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "review_products_shop_id_status_idx" ON "review_products"("shop_id", "status");

-- CreateIndex
CREATE INDEX "review_products_shop_id_product_id_status_idx" ON "review_products"("shop_id", "product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_products_shop_id_product_id_review_id_key" ON "review_products"("shop_id", "product_id", "review_id");

-- CreateIndex
CREATE INDEX "qna_questions_shop_id_idx" ON "qna_questions"("shop_id");

-- CreateIndex
CREATE INDEX "qna_questions_shop_id_product_id_idx" ON "qna_questions"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "qna_questions_shop_id_status_idx" ON "qna_questions"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "qna_questions_shop_id_product_id_question_id_key" ON "qna_questions"("shop_id", "product_id", "question_id");

-- AddForeignKey
ALTER TABLE "AppInstall" ADD CONSTRAINT "AppInstall_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopDomain" ADD CONSTRAINT "ShopDomain_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionSnapshot" ADD CONSTRAINT "SubscriptionSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

