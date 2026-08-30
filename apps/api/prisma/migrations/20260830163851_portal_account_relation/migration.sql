-- `shop_owner_user_id` has existed since the first migration with no foreign
-- key behind it, so it could name a user that was never there. The portal
-- login reads it to decide whose data a session may see, which is not a column
-- to leave unenforced.
--
-- Unique as well as referential: one login belongs to one shop. Without that,
-- two customers could name the same portal user and a session would see
-- whichever the query happened to return first — an ownership bug that reads
-- as a caching one.

CREATE UNIQUE INDEX "customers_shop_owner_user_id_key" ON "customers"("shop_owner_user_id");

ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_owner_user_id_fkey"
  FOREIGN KEY ("shop_owner_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
