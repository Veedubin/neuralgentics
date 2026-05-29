-- Drop all tables in reverse dependency order
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS thoughts CASCADE;
DROP TABLE IF EXISTS thought_chains CASCADE;
DROP TABLE IF EXISTS trust_adjustments CASCADE;
DROP TABLE IF EXISTS user_profiles CASCADE;
DROP TABLE IF EXISTS memory_sharing CASCADE;
DROP TABLE IF EXISTS entity_relationships CASCADE;
DROP TABLE IF EXISTS entities CASCADE;
DROP TABLE IF EXISTS memory_relationships CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS peers CASCADE;

-- Drop extensions (optional — leave vector installed in production)
-- DROP EXTENSION IF EXISTS vectorscale;
-- DROP EXTENSION IF EXISTS vector;