-- PostgreSQL owner-local aggregates and transactional workflow/outbox/inbox.
-- JSONB payloads are validated by owner domain + OpenAPI; unique business keys stay in PostgreSQL.
CREATE TABLE IF NOT EXISTS cab_records (collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'), PRIMARY KEY(collection,id));
CREATE INDEX IF NOT EXISTS cab_records_data ON cab_records USING GIN(data jsonb_path_ops);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON cab_records ((data->>'phone')) WHERE collection='users' AND data->>'phone' IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON cab_records ((data->>'email')) WHERE collection='users' AND data->>'email' IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_userid ON cab_records ((data->>'userId')) WHERE collection='registrations' AND data->>'userId' IS NOT NULL;
CREATE OR REPLACE FUNCTION protect_cab_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.collection='audit' THEN RAISE EXCEPTION 'audit is append-only'; END IF; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
DROP TRIGGER IF EXISTS cab_audit_immutable ON cab_records;
CREATE TRIGGER cab_audit_immutable BEFORE UPDATE OR DELETE ON cab_records FOR EACH ROW EXECUTE FUNCTION protect_cab_audit();
