CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE
);
-- Add user_id if missing (migrations from pre-multiuser)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='settings' AND column_name='user_id') THEN
    ALTER TABLE settings ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
-- Drop legacy pkey on key alone, add composite (user_id, key)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='settings_pkey' AND tablename='settings') THEN
    BEGIN ALTER TABLE settings DROP CONSTRAINT settings_pkey; EXCEPTION WHEN others THEN NULL; END;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key_uniq ON settings(user_id, key);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction TEXT NOT NULL CHECK (direction IN ('in','out','system')),
  channel TEXT NOT NULL,
  content TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='user_id') THEN
    ALTER TABLE messages ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages(ts DESC);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id);

CREATE TABLE IF NOT EXISTS connectors (
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='connectors' AND column_name='user_id') THEN
    ALTER TABLE connectors ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='connectors_pkey' AND tablename='connectors') THEN
    BEGIN ALTER TABLE connectors DROP CONSTRAINT connectors_pkey; EXCEPTION WHEN others THEN NULL; END;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS connectors_user_name_uniq ON connectors(user_id, name);

CREATE TABLE IF NOT EXISTS brain_index (
  id BIGSERIAL PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  summary TEXT,
  refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='brain_index' AND column_name='user_id') THEN
    ALTER TABLE brain_index ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  BEGIN ALTER TABLE brain_index DROP CONSTRAINT brain_index_path_key; EXCEPTION WHEN others THEN NULL; END;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS brain_index_user_path_uniq ON brain_index(user_id, path);
CREATE INDEX IF NOT EXISTS brain_index_kind_idx ON brain_index(kind);
CREATE INDEX IF NOT EXISTS brain_index_tags_idx ON brain_index USING GIN(tags);

CREATE TABLE IF NOT EXISTS people (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  emails TEXT[] NOT NULL DEFAULT '{}',
  note_path TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='people' AND column_name='user_id') THEN
    ALTER TABLE people ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  BEGIN ALTER TABLE people DROP CONSTRAINT people_slug_key; EXCEPTION WHEN others THEN NULL; END;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS people_user_slug_uniq ON people(user_id, slug);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB
);
CREATE INDEX IF NOT EXISTS jobs_ts_idx ON jobs(ts DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_usd NUMERIC(10,6),
  num_turns INTEGER,
  prompt TEXT,
  result TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_ts_idx ON agent_runs(ts DESC);
CREATE INDEX IF NOT EXISTS agent_runs_kind_idx ON agent_runs(kind);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_runs' AND column_name='user_id') THEN
    ALTER TABLE agent_runs ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_tasks' AND column_name='user_id') THEN
    ALTER TABLE scheduled_tasks ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS scheduled_tasks_user_idx ON scheduled_tasks(user_id);

CREATE TABLE IF NOT EXISTS internal_agents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  hour INTEGER NOT NULL DEFAULT 4,
  minute INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  last_report JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS internal_agents_user_name_uniq ON internal_agents(user_id, name);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='internal_agents' AND column_name='notify_on_run') THEN
    ALTER TABLE internal_agents ADD COLUMN notify_on_run BOOLEAN NOT NULL DEFAULT true;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
ALTER TABLE internal_agents ALTER COLUMN notify_on_run SET DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='brain_index' AND column_name='visibility') THEN
    ALTER TABLE brain_index ADD COLUMN visibility TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS brain_index_visibility_idx ON brain_index(visibility);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='user_id') THEN
    ALTER TABLE jobs ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('notify','prompt','tool')),
  action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  last_result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_tasks_enabled_idx ON scheduled_tasks(enabled);
