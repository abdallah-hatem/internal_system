-- AlterEnum
ALTER TYPE "CycleStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "currency_rates" ALTER COLUMN "updated_at" DROP DEFAULT;
