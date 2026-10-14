-- Arabic search forgives spelling (BUSINESS_LOGIC §3, owner 2026-10-15).
-- Additive: one nullable column and one function. Nothing existing changes.
--
-- Prisma's `contains` cannot fold أ/ا, ة/ه, ى/ي or the vowel marks, so a
-- product carries its Arabic name's search key beside it, and a search
-- compares the key of what was typed against that. The API writes the key on
-- every write of `name_ar` with `arabicSearchKey` (apps/api/src/common/
-- arabic-names.ts). This function is the same rule in SQL, for the backfill
-- below and for scripts/check-data.sh, which counts any product whose stored
-- key is not what this function makes of its name. 99-arabic-search runs the
-- shared case table (arabic-search-cases.json) through both and requires the
-- same answer, so the two cannot drift apart unnoticed.
--
-- The rule: drop U+064B–U+065F (vowel marks, tanween, shadda, sukun, madda
-- and hamza marks), U+0670 (superscript alef) and U+0640 (tatweel); read
-- آ أ إ as ا, ؤ as و, ئ as ي, ة as ه, ى as ي; lower-case; trim.
--
-- Prisma's schema does not describe functions, so `migrate diff` will neither
-- see nor offer to drop this one.

CREATE OR REPLACE FUNCTION arabic_search_key(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
           lower(
             translate(
               regexp_replace(t, '[ً-ٰٟـ]', '', 'g'),
               U&'\0622\0623\0625\0624\0626\0629\0649',
               U&'\0627\0627\0627\0648\064A\0647\064A'
             )
           ),
           '^\s+|\s+$', '', 'g'
         )
$$;

-- AlterTable
ALTER TABLE "products" ADD COLUMN "name_ar_search" TEXT;

-- Backfill: every product that already has an Arabic name gets its key.
UPDATE "products"
   SET "name_ar_search" = NULLIF(arabic_search_key("name_ar"), '')
 WHERE "name_ar" IS NOT NULL;
