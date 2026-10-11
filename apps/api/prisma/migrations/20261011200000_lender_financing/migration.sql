-- CreateTable
CREATE TABLE "lenders" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "lenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lender_financings" (
    "id" UUID NOT NULL,
    "lender_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "fx_rate_to_egp" DECIMAL(18,4) NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledger_transaction_id" UUID,
    "removed_at" TIMESTAMPTZ,
    "removed_by" UUID,
    "removal_reason" TEXT,
    "removal_transaction_id" UUID,

    CONSTRAINT "lender_financings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lender_repayments" (
    "id" UUID NOT NULL,
    "financing_id" UUID NOT NULL,
    "paid_on" DATE NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "rate_to_egp" DECIMAL(18,4) NOT NULL,
    "cleared" DECIMAL(18,2) NOT NULL,
    "cleared_at_order_rate_egp" DECIMAL(18,2) NOT NULL,
    "exchange_diff_egp" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledger_transaction_id" UUID,
    "reversed_at" TIMESTAMPTZ,
    "reversed_by" UUID,
    "reversal_reason" TEXT,
    "reversal_transaction_id" UUID,

    CONSTRAINT "lender_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lender_plans" (
    "id" UUID NOT NULL,
    "financing_id" UUID NOT NULL,
    "agreed_on" DATE NOT NULL,
    "status" "PaymentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "cancel_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "lender_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lender_plan_instalments" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "lender_plan_instalments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lender_financings_ledger_transaction_id_key" ON "lender_financings"("ledger_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "lender_financings_removal_transaction_id_key" ON "lender_financings"("removal_transaction_id");

-- CreateIndex
CREATE INDEX "lender_financings_lender_id_idx" ON "lender_financings"("lender_id");

-- CreateIndex
CREATE INDEX "lender_financings_purchase_order_id_idx" ON "lender_financings"("purchase_order_id");

-- CreateIndex
CREATE INDEX "lender_financings_cycle_id_idx" ON "lender_financings"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "lender_repayments_ledger_transaction_id_key" ON "lender_repayments"("ledger_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "lender_repayments_reversal_transaction_id_key" ON "lender_repayments"("reversal_transaction_id");

-- CreateIndex
CREATE INDEX "lender_repayments_financing_id_idx" ON "lender_repayments"("financing_id");

-- CreateIndex
CREATE INDEX "lender_plans_financing_id_idx" ON "lender_plans"("financing_id");

-- CreateIndex
CREATE UNIQUE INDEX "lender_plan_instalments_plan_id_sequence_key" ON "lender_plan_instalments"("plan_id", "sequence");

-- AddForeignKey
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_lender_id_fkey" FOREIGN KEY ("lender_id") REFERENCES "lenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "import_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_repayments" ADD CONSTRAINT "lender_repayments_financing_id_fkey" FOREIGN KEY ("financing_id") REFERENCES "lender_financings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_repayments" ADD CONSTRAINT "lender_repayments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "money_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_plans" ADD CONSTRAINT "lender_plans_financing_id_fkey" FOREIGN KEY ("financing_id") REFERENCES "lender_financings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_plan_instalments" ADD CONSTRAINT "lender_plan_instalments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "lender_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One friend pays for one order once (§18); a removed financing does not count.
CREATE UNIQUE INDEX "lender_financings_one_standing_per_lender_order"
  ON "lender_financings"("lender_id", "purchase_order_id") WHERE "removed_at" IS NULL;

-- One active repayment plan per financing (the §7 habit).
CREATE UNIQUE INDEX "lender_plans_one_active_per_financing"
  ON "lender_plans"("financing_id") WHERE "status" = 'ACTIVE';

-- The database refuses what the service refuses, so a script cannot write it either.
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_amount_positive" CHECK ("amount" > 0 AND "fx_rate_to_egp" > 0);
ALTER TABLE "lender_repayments" ADD CONSTRAINT "lender_repayments_positive" CHECK ("amount_egp" > 0 AND "rate_to_egp" > 0 AND "cleared" > 0);
ALTER TABLE "lender_plan_instalments" ADD CONSTRAINT "lender_plan_instalments_amount_positive" CHECK ("amount" > 0);
