-- Structured synthesis output (executive summary, recommendations, health score)
-- persisted alongside the Markdown that already embeds it. Nullable: reports
-- written before this column keep working, the dashboard falls back to prose.
ALTER TABLE "reports" ADD COLUMN "synthesis" JSONB;
ALTER TABLE "reports" ADD COLUMN "total_tokens" INTEGER NOT NULL DEFAULT 0;

-- View-only share links. The token is the capability; a CodeMind session is
-- still required to redeem it. Revocation is a timestamp, not a delete.
CREATE TABLE "report_shares" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_shares_token_key" ON "report_shares"("token");
CREATE INDEX "report_shares_report_id_idx" ON "report_shares"("report_id");

ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_report_id_fkey"
    FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
