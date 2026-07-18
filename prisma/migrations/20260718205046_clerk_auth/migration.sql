-- DropForeignKey
ALTER TABLE "agent_results" DROP CONSTRAINT "agent_results_job_id_fkey";

-- DropForeignKey
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_user_id_fkey";

-- DropForeignKey
ALTER TABLE "report_shares" DROP CONSTRAINT "report_shares_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_job_id_fkey";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "clerk_id" TEXT NOT NULL,
ADD COLUMN     "email" TEXT,
ALTER COLUMN "github_id" DROP NOT NULL,
ALTER COLUMN "github_access_token_encrypted" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_results" ADD CONSTRAINT "agent_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

