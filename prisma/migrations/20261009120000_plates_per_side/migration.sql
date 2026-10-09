ALTER TABLE "PlannedSet" ADD COLUMN "platesPerSide" DECIMAL(9,3)[] NOT NULL DEFAULT ARRAY[]::DECIMAL(9,3)[];
ALTER TABLE "PlannedSet" ADD CONSTRAINT "PlannedSet_platesPerSide_check" CHECK (cardinality("platesPerSide") <= 20 AND array_position("platesPerSide", NULL) IS NULL AND 0 < ALL("platesPerSide") AND ("loadValue" IS NOT NULL OR cardinality("platesPerSide") = 0));
