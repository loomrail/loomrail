-- Q17 binds daemon-measured Project verification to the AcceptancePackage without putting raw
-- output or local paths into the package. NULL preserves packages created before Project
-- verification existed and Projects whose owner has not adopted a VerificationPlan.

ALTER TABLE acceptance_packages
ADD COLUMN verification_evidence_json TEXT
CHECK (verification_evidence_json IS NULL OR json_valid(verification_evidence_json));
