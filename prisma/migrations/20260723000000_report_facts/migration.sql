-- Persist the AST ground truth alongside the report.
--
-- RepoFacts previously died in the synthesizer: the Markdown quoted the measured
-- module table, routes and complexity hotspots, while the dashboard fell back to
-- the agents' guessed versions of the same things. Storing it makes both surfaces
-- read from one source.
--
-- Nullable and additive: every existing report row stays valid and renders as it
-- did, just without the measured sections.
ALTER TABLE "reports" ADD COLUMN "facts" JSONB;
