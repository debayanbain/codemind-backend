-- Add a terminal `cancelled` state for user-aborted jobs.
-- Additive enum value; PG 12+ permits ALTER TYPE ... ADD VALUE (the new value
-- is not referenced in this same migration).
ALTER TYPE "JobStatus" ADD VALUE 'cancelled';
