-- Arabic names for categories and products (BUSINESS_LOGIC §3, owner
-- 2026-10-14). Additive and nullable: every existing row keeps its English
-- name, which an Arabic reader sees until someone adds the Arabic.
--
-- The partial unique index is written by hand: Prisma's schema cannot say
-- "unique on lower(name_ar) where present". Values are stored trimmed, so
-- lower() is the only folding left to do. A future `migrate diff` will offer
-- to DROP this index because the schema does not describe it. Delete that
-- line from the generated SQL.

-- AlterTable
ALTER TABLE "categories" ADD COLUMN "name_ar" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN "name_ar" TEXT,
ADD COLUMN "description_ar" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_ar_key" ON "categories" (lower("name_ar")) WHERE "name_ar" IS NOT NULL;
