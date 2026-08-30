-- CreateEnum
CREATE TYPE "AssetVariant" AS ENUM ('ORIGINAL', 'CARD', 'THUMB');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "ProductRequestStatus" AS ENUM ('PENDING', 'SOURCING', 'ANSWERED', 'DECLINED');

-- CreateEnum
CREATE TYPE "OrderRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

-- DropForeignKey
ALTER TABLE "file_assets" DROP CONSTRAINT "file_assets_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "inventory_reservations" DROP CONSTRAINT "inventory_reservations_sale_order_id_fkey";

-- AlterTable
ALTER TABLE "file_assets" DROP COLUMN "owner_id",
DROP COLUMN "owner_type",
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "parent_asset_id" UUID,
ADD COLUMN     "product_id" UUID,
ADD COLUMN     "product_request_id" UUID,
ADD COLUMN     "uploaded_by" UUID,
ADD COLUMN     "variant" "AssetVariant" NOT NULL DEFAULT 'ORIGINAL',
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "inventory_reservations" ADD COLUMN     "order_request_id" UUID,
ADD COLUMN     "released_at" TIMESTAMPTZ,
ALTER COLUMN "sale_order_id" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "product_requests" DROP COLUMN "asset_id",
ADD COLUMN     "decided_at" TIMESTAMPTZ,
ADD COLUMN     "decision_note" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "ProductRequestStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "order_requests" (
    "id" UUID NOT NULL,
    "request_no" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "OrderRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decision_note" TEXT,
    "hold_expires_at" TIMESTAMPTZ,
    "hold_released_at" TIMESTAMPTZ,
    "sale_order_id" UUID,
    "decided_at" TIMESTAMPTZ,
    "decided_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "order_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_request_items" (
    "id" UUID NOT NULL,
    "order_request_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty_requested" DECIMAL(18,3) NOT NULL,
    "qty_approved" DECIMAL(18,3),
    "unit_price" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "order_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMPTZ,
    "failure_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_requests_request_no_key" ON "order_requests"("request_no");

-- CreateIndex
CREATE UNIQUE INDEX "order_requests_sale_order_id_key" ON "order_requests"("sale_order_id");

-- CreateIndex
CREATE INDEX "order_requests_customer_id_status_idx" ON "order_requests"("customer_id", "status");

-- CreateIndex
CREATE INDEX "order_requests_status_hold_expires_at_idx" ON "order_requests"("status", "hold_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "file_assets_product_id_idx" ON "file_assets"("product_id");

-- CreateIndex
CREATE INDEX "file_assets_product_request_id_idx" ON "file_assets"("product_request_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_status_expires_at_idx" ON "inventory_reservations"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_parent_asset_id_fkey" FOREIGN KEY ("parent_asset_id") REFERENCES "file_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_product_request_id_fkey" FOREIGN KEY ("product_request_id") REFERENCES "product_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sale_order_id_fkey" FOREIGN KEY ("sale_order_id") REFERENCES "sale_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_request_id_fkey" FOREIGN KEY ("order_request_id") REFERENCES "order_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_sale_order_id_fkey" FOREIGN KEY ("sale_order_id") REFERENCES "sale_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_order_request_id_fkey" FOREIGN KEY ("order_request_id") REFERENCES "order_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- What Prisma cannot say, and what would otherwise be left to hope.
-- ─────────────────────────────────────────────────────────────────────

-- A reservation holds for an order OR for a request, never both and never
-- neither. `sale_order_id` used to be NOT NULL, which is why the table sat
-- unused: it could only hold for something that was already an order, and a
-- hold exists precisely before there is one.
ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_one_owner"
  CHECK (num_nonnulls("sale_order_id", "order_request_id") = 1);

-- The same for a file. `owner_type` / `owner_id` was polymorphic in name only —
-- `owner_id` carried a foreign key to products, so a photo on a customer's
-- request failed the constraint. Two explicit columns keep integrity; this
-- keeps them from both being filled, or neither.
ALTER TABLE "file_assets"
  ADD CONSTRAINT "file_assets_one_owner"
  CHECK (num_nonnulls("product_id", "product_request_id") = 1);

-- A held quantity is a positive number of things.
ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_qty_positive" CHECK ("qty" > 0);

-- And a request cannot ask for nothing, or for less than nothing.
ALTER TABLE "order_request_items"
  ADD CONSTRAINT "order_request_items_qty_positive" CHECK ("qty_requested" > 0);
ALTER TABLE "order_request_items"
  ADD CONSTRAINT "order_request_items_approved_not_negative"
  CHECK ("qty_approved" IS NULL OR "qty_approved" >= 0);
