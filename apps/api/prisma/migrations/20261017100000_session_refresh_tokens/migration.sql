-- Office sign-ins that last (owner, 2026-10-17). Additive only: a new table,
-- nothing existing changes, so it is safe to run before the code that uses it.

-- CreateTable
CREATE TABLE "session_refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by_id" UUID,

    CONSTRAINT "session_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_refresh_tokens_token_hash_key" ON "session_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "session_refresh_tokens_user_id_idx" ON "session_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "session_refresh_tokens_family_id_idx" ON "session_refresh_tokens"("family_id");

-- AddForeignKey
ALTER TABLE "session_refresh_tokens" ADD CONSTRAINT "session_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
