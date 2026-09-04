ALTER TABLE budget_policies ADD COLUMN agent_run_max_estimated_tokens_override INTEGER CHECK (
  agent_run_max_estimated_tokens_override IS NULL OR agent_run_max_estimated_tokens_override > 0
);
