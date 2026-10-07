ALTER TABLE "PlannedSet" ADD COLUMN "restSeconds" INTEGER;
ALTER TABLE "PlannedSet" ADD CONSTRAINT "PlannedSet_restSeconds_check" CHECK ("restSeconds" BETWEEN 0 AND 3600);
