-- A sale's create key is stored with the order (U2), so a retried POST returns
-- the order it already made — on any server instance, not only the one that
-- remembered it. Additive: existing orders keep a NULL key, and Postgres
-- treats NULLs as distinct, so they never collide.

-- AlterTable
ALTER TABLE "sale_orders" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sale_orders_created_by_idempotency_key_key" ON "sale_orders"("created_by", "idempotency_key");
