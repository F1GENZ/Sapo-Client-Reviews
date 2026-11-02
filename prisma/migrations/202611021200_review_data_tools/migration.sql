CREATE TABLE "widget_config_revisions" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "store_domain" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_config_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_runs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "store_domain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "widget_config_revisions_store_domain_created_at_idx" ON "widget_config_revisions"("store_domain", "created_at");
CREATE INDEX "widget_config_revisions_shop_id_created_at_idx" ON "widget_config_revisions"("shop_id", "created_at");
CREATE INDEX "import_runs_store_domain_created_at_idx" ON "import_runs"("store_domain", "created_at");
