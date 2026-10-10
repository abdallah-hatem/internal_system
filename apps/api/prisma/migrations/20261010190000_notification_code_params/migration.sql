-- U5: a notification names what happened with a code and its params, so the
-- reader's app says it in the reader's language. Additive and nullable: rows
-- written before this keep only their English title, which is still shown.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "code" TEXT,
ADD COLUMN     "params" JSONB;
