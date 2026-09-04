ALTER TABLE budget_policies ADD COLUMN model_tier_override TEXT CHECK (
  model_tier_override IS NULL OR model_tier_override IN ('FAST', 'STANDARD', 'DEEP')
);
