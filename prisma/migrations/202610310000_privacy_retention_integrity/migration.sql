ALTER TABLE "customer_purchases" ADD COLUMN     "hash_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "source_updated_at" BIGINT;
