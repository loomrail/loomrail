-- Mock provider rows remain immutable historical evidence, but a Project may no longer select
-- MOCK for future dispatch. AUTO will resolve only to configured real API adapters.
UPDATE projects
SET provider_preference = 'AUTO'
WHERE provider_preference = 'MOCK';
