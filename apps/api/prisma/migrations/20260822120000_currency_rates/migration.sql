-- Current FX rates, used to prefill forms.
--
-- Not a historical record: every document stores the rate it was agreed at, so
-- updating a row here never moves a figure already recorded.
CREATE TABLE "currency_rates" (
    "code" TEXT NOT NULL,
    "rate_to_egp" DECIMAL(18,4),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currency_rates_pkey" PRIMARY KEY ("code")
);

-- Opening rates, agreed 2026-08-22. CNY is listed without one: the business
-- buys from China but no rate was given, and guessing it would put a wrong
-- number into a landed cost. Until it is set, the form asks as it does today.
INSERT INTO "currency_rates" ("code", "rate_to_egp", "source") VALUES
    ('EGP', 1,       'base'),
    ('AED', 13.8500, 'manual'),
    ('USD', 50.8600, 'manual'),
    ('CNY', NULL,    'manual')
ON CONFLICT ("code") DO NOTHING;
