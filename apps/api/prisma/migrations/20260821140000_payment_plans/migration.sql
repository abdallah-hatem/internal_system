-- CreateEnum
CREATE TYPE "PaymentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "total_egp" DECIMAL(18,2) NOT NULL,
    "agreed_on" DATE NOT NULL,
    "status" "PaymentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_plan_instalments" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,

    CONSTRAINT "payment_plan_instalments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_plans_reference_key" ON "payment_plans"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_plan_instalments_plan_id_sequence_key" ON "payment_plan_instalments"("plan_id", "sequence");

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan_instalments" ADD CONSTRAINT "payment_plan_instalments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "payment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

