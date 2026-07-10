-- Rendered diagrams (D2 SVG + chart SVG) persisted alongside the report markdown.
-- Defaulted to '[]' so pre-existing reports remain readable; they simply have no
-- diagrams and their old Mermaid fences render as inert code blocks.
ALTER TABLE "reports" ADD COLUMN "diagrams" JSONB NOT NULL DEFAULT '[]';
