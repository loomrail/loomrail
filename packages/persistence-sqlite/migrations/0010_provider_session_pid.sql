-- The process a RUNNING session is driving, so a daemon that died without killing it can find that
-- process on the next start. Nullable on purpose: a session that never reached `spawn` has no
-- process, and that is a different fact from "a process whose pid is 0".
ALTER TABLE provider_sessions
  ADD COLUMN process_pid INTEGER CHECK (process_pid IS NULL OR process_pid > 0);
