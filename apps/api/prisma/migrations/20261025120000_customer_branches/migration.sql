-- A customer with branches (owner, 2026-10-25; BUSINESS_LOGIC §7 "A customer
-- with branches"). Additive only: a new table and one nullable column. Every
-- existing customer has no branches and every existing order no branch, so no
-- figure changes.

-- CreateTable
CREATE TABLE "customer_branches" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customer_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_branches_customer_id_idx" ON "customer_branches"("customer_id");

-- A name once per customer, ignoring case: "LS2" and "ls2" are one branch.
-- Prisma cannot express an index on an expression; the service checks first
-- so the usual refusal is coded, and this stops two saves racing past it.
CREATE UNIQUE INDEX "customer_branches_customer_name" ON "customer_branches"("customer_id", lower("name"));

-- At most one default per customer. Partial, so any number may be false.
CREATE UNIQUE INDEX "customer_branches_one_default" ON "customer_branches"("customer_id") WHERE "is_default";

-- AddForeignKey
ALTER TABLE "customer_branches" ADD CONSTRAINT "customer_branches_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "sale_orders" ADD COLUMN "branch_id" UUID;

-- CreateIndex
CREATE INDEX "sale_orders_branch_id_idx" ON "sale_orders"("branch_id");

-- AddForeignKey
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "customer_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
