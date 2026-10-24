ALTER TABLE "PlannedSet" ADD COLUMN "repsGoal" INTEGER;
ALTER TABLE "PlannedSet" ADD CONSTRAINT "PlannedSet_repsGoal_check" CHECK ("repsGoal" IS NULL OR ("repsGoal" >= "repsMin" AND "repsGoal" <= "repsMax"));
