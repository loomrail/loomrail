-- Spec docs/plans/07-a1-session-handoff-spec.ru.md §7 (the mis-estimated-pack branch).
--
-- When a provider rejects a pack Loomrail judged as fitting, the pack share for the next session of
-- the same StageAttempt drops by a fixed step; after one such retry the attempt asks the owner
-- instead of narrowing blindly. That "one retry" has to survive a daemon restart for the same
-- reason `unproductive_sessions` does (§6.4 makes a restart the ordinary end of a session), so the
-- count lives here rather than in daemon memory.

ALTER TABLE stage_attempts
  ADD COLUMN pack_share_backoffs INTEGER NOT NULL DEFAULT 0
  CHECK (pack_share_backoffs >= 0);
