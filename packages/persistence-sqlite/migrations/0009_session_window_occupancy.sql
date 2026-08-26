-- Spec docs/plans/07-a1-session-handoff-spec.ru.md §6.2: window occupancy is saved.
--
-- It was not. Below the handoff threshold `REQUEST_CONTEXT_HANDOFF` decided NO_ACTION and wrote
-- nothing, so the only occupancy that survived a session was the single reading that crossed the
-- threshold, and only as a field inside the CONTEXT_HANDOFF_REQUESTED audit event.
-- LIST_PROVIDER_SESSIONS then rebuilt a displayable number by scanning that event log, which is
-- exactly the separation of current state from audit that AGENTS.md forbids collapsing.
--
-- These four columns give the reading a home in current state. What they hold is the HIGHEST
-- occupancy the session has been observed at, not its current one: that is the figure that answers
-- "how full did this session get", which is what explains a cut after the fact, and the write in
-- REQUEST_CONTEXT_HANDOFF enforces it rather than trusting the order reports arrive in. All four
-- are nullable together: a session that has never been measured has no occupancy at all, and that
-- is a different fact from a session measured at zero.

ALTER TABLE provider_sessions
  ADD COLUMN context_used_tokens INTEGER
  CHECK (context_used_tokens IS NULL OR context_used_tokens >= 0);

ALTER TABLE provider_sessions
  ADD COLUMN context_window_tokens INTEGER
  CHECK (context_window_tokens IS NULL OR context_window_tokens > 0);

ALTER TABLE provider_sessions
  ADD COLUMN context_usage_quality TEXT
  CHECK (
    context_usage_quality IS NULL OR
    context_usage_quality IN ('ACTUAL', 'PROVIDER_ESTIMATE', 'LOOMRAIL_ESTIMATE')
  );

-- Mirrors the two-sided CHECKs 0006 wrote for this table's status/end_reason pair, and carries the
-- whole-row invariant because it is the last column added: contextWindowUsageSchema is one value
-- with three parts plus the moment it was reported, so all four are present or all four are absent
-- -- never a used count with no window to measure it against. `usedTokens <= windowTokens` is the
-- schema's own refine and stays there; SQLite would accept it here too, but a stored row that
-- predates the constraint cannot be re-checked by ALTER TABLE, so the parse on read is the honest
-- place for it.
ALTER TABLE provider_sessions
  ADD COLUMN context_usage_reported_at TEXT
  CHECK (
    (context_usage_reported_at IS NULL) = (context_used_tokens IS NULL) AND
    (context_usage_reported_at IS NULL) = (context_window_tokens IS NULL) AND
    (context_usage_reported_at IS NULL) = (context_usage_quality IS NULL)
  );
