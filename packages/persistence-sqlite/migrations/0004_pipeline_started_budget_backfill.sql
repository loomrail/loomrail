DROP TRIGGER events_are_append_only_update;
DROP TRIGGER commands_are_append_only_update;

UPDATE events
SET data_json = json_set(
  data_json,
  '$.budgetPolicy',
  json_object(
    'schemaVersion', 1,
    'id', 'budget-migrated-' || json_extract(data_json, '$.run.id'),
    'projectId', json_extract(data_json, '$.run.projectId'),
    'workItemId', json_extract(data_json, '$.run.workItemId'),
    'pipelineRunId', json_extract(data_json, '$.run.id'),
    'revision', 1,
    'maxEstimatedTokens', 100,
    'warningThresholds', json('[0.5,0.8,0.95]'),
    'createdBy', json_object('type', 'SYSTEM', 'id', 'migration-0003'),
    'createdAt', json_extract(data_json, '$.run.createdAt')
  )
)
WHERE type = 'PIPELINE_STARTED'
  AND json_type(data_json, '$.budgetPolicy') IS NULL;

UPDATE commands
SET result_json = json_set(
  result_json,
  '$.budgetPolicy',
  json_object(
    'schemaVersion', 1,
    'id', 'budget-migrated-' || json_extract(result_json, '$.run.id'),
    'projectId', json_extract(result_json, '$.run.projectId'),
    'workItemId', json_extract(result_json, '$.run.workItemId'),
    'pipelineRunId', json_extract(result_json, '$.run.id'),
    'revision', 1,
    'maxEstimatedTokens', 100,
    'warningThresholds', json('[0.5,0.8,0.95]'),
    'createdBy', json_object('type', 'SYSTEM', 'id', 'migration-0003'),
    'createdAt', json_extract(result_json, '$.run.createdAt')
  ),
  '$.events[0].data.budgetPolicy',
  json_object(
    'schemaVersion', 1,
    'id', 'budget-migrated-' || json_extract(result_json, '$.run.id'),
    'projectId', json_extract(result_json, '$.run.projectId'),
    'workItemId', json_extract(result_json, '$.run.workItemId'),
    'pipelineRunId', json_extract(result_json, '$.run.id'),
    'revision', 1,
    'maxEstimatedTokens', 100,
    'warningThresholds', json('[0.5,0.8,0.95]'),
    'createdBy', json_object('type', 'SYSTEM', 'id', 'migration-0003'),
    'createdAt', json_extract(result_json, '$.run.createdAt')
  )
)
WHERE command_type = 'START_MOCK_PIPELINE'
  AND json_type(result_json, '$.budgetPolicy') IS NULL;

UPDATE commands
SET result_json = json_set(result_json, '$.usageRecords', json('[]'))
WHERE command_type = 'APPLY_MOCK_PROVIDER_OUTCOME'
  AND json_type(result_json, '$.usageRecords') IS NULL;

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands
BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;
