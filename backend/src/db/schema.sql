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

-- Optional sub-daily cadence: when > 0, agent fires every N hours
-- (in addition to the daily hour:minute anchor). NULL/0 = daily only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='internal_agents' AND column_name='interval_hours') THEN
    ALTER TABLE internal_agents ADD COLUMN interval_hours INTEGER;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- Live "running" flag — toggled by runInternalAgent so sidebar can show active perks
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='internal_agents' AND column_name='running') THEN
    ALTER TABLE internal_agents ADD COLUMN running BOOLEAN NOT NULL DEFAULT false;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- P2P Brain Network
CREATE TABLE IF NOT EXISTS user_connections (
  id BIGSERIAL PRIMARY KEY,
  a_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','blocked')) DEFAULT 'pending',
  initiator_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT user_connections_pair_uniq UNIQUE (a_user_id, b_user_id),
  CONSTRAINT user_connections_order CHECK (a_user_id < b_user_id)
);

CREATE TABLE IF NOT EXISTS brain_share_requests (
  id BIGSERIAL PRIMARY KEY,
  requester_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query_text TEXT NOT NULL,
  agent_review JSONB,
  approved_items JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending','reviewed','approved','denied','delivered','expired')) DEFAULT 'pending',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS brain_share_requests_target_idx ON brain_share_requests(target_user_id, status);
CREATE INDEX IF NOT EXISTS brain_share_requests_requester_idx ON brain_share_requests(requester_user_id, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='brain_index' AND column_name='origin_user_id') THEN
    ALTER TABLE brain_index ADD COLUMN origin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS brain_index_origin_idx ON brain_index(origin_user_id);

-- Multi-vault support
CREATE TABLE IF NOT EXISTS vaults (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vaults_user_name_uniq ON vaults(user_id, name);
CREATE INDEX IF NOT EXISTS vaults_user_primary_idx ON vaults(user_id, is_primary);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='brain_index' AND column_name='vault_id') THEN
    ALTER TABLE brain_index ADD COLUMN vault_id BIGINT REFERENCES vaults(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS brain_index_vault_idx ON brain_index(vault_id);

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

-- user_id patch: must run AFTER scheduled_tasks exists (fresh installs created the
-- table without this column; this idempotently backfills it on new and old DBs).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_tasks' AND column_name='user_id') THEN
    ALTER TABLE scheduled_tasks ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS scheduled_tasks_user_idx ON scheduled_tasks(user_id);

-- Sub-agents (human-in-the-loop spawned by main agent)
CREATE TABLE IF NOT EXISTS agent_proposals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  reason TEXT,
  proposals JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  telegram_message_id BIGINT,
  telegram_chat_id BIGINT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_proposals_user_idx ON agent_proposals(user_id, status);

CREATE TABLE IF NOT EXISTS sub_agents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id BIGINT REFERENCES agent_proposals(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  brief TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','cancelled')),
  result TEXT,
  error TEXT,
  run_id BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL,
  cost_usd NUMERIC,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_agents_user_status_idx ON sub_agents(user_id, status);
CREATE INDEX IF NOT EXISTS sub_agents_user_created_idx ON sub_agents(user_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sub_agents' AND column_name='actions') THEN
    ALTER TABLE sub_agents ADD COLUMN actions JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sub_agents' AND column_name='input_tokens') THEN
    ALTER TABLE sub_agents ADD COLUMN input_tokens INTEGER;
    ALTER TABLE sub_agents ADD COLUMN output_tokens INTEGER;
    ALTER TABLE sub_agents ADD COLUMN num_turns INTEGER;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- SMTP draft replies (created by agent, approved by user before send)
CREATE TABLE IF NOT EXISTS email_drafts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_addr TEXT NOT NULL,
  cc_addr TEXT,
  bcc_addr TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  in_reply_to TEXT,
  references_ids TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','sent','error')),
  telegram_message_id BIGINT,
  telegram_chat_id BIGINT,
  decided_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_drafts_user_status_idx ON email_drafts(user_id, status, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='email_drafts' AND column_name='account_label') THEN
    ALTER TABLE email_drafts ADD COLUMN account_label TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='people' AND column_name='phones') THEN
    ALTER TABLE people ADD COLUMN phones TEXT[] NOT NULL DEFAULT '{}';
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS people_phones_idx ON people USING gin(phones);

CREATE TABLE IF NOT EXISTS wa_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  sender_phone TEXT,
  sender_name TEXT,
  person_slug TEXT,
  is_group BOOLEAN NOT NULL DEFAULT false,
  group_jid TEXT,
  from_me BOOLEAN NOT NULL DEFAULT false,
  text TEXT NOT NULL DEFAULT '',
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, msg_id)
);
CREATE INDEX IF NOT EXISTS wa_messages_user_chat_ts_idx ON wa_messages(user_id, chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS wa_messages_user_ts_idx ON wa_messages(user_id, ts DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_messages' AND column_name='processed_at') THEN
    ALTER TABLE wa_messages ADD COLUMN processed_at TIMESTAMPTZ;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wa_messages_user_processed_idx ON wa_messages(user_id, processed_at);

CREATE TABLE IF NOT EXISTS wa_contacts (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT,
  notify TEXT,
  verified_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, jid)
);
CREATE INDEX IF NOT EXISTS wa_contacts_user_idx ON wa_contacts(user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_contacts' AND column_name='lid') THEN
    ALTER TABLE wa_contacts ADD COLUMN lid TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wa_contacts_user_lid_idx ON wa_contacts(user_id, lid);

-- Per-chat auto-bonify flag — when true, scheduler will auto-run bonifyWaMessages on this chat
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_contacts' AND column_name='auto_bonify') THEN
    ALTER TABLE wa_contacts ADD COLUMN auto_bonify BOOLEAN NOT NULL DEFAULT false;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wa_contacts_user_autobonify_idx ON wa_contacts(user_id) WHERE auto_bonify=true;

CREATE TABLE IF NOT EXISTS tool_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  server TEXT,
  is_mcp BOOLEAN NOT NULL DEFAULT false,
  brief TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_events_user_ts_idx ON tool_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS tool_events_user_mcp_idx ON tool_events(user_id, is_mcp, ts DESC);

-- Origin tag (perk name, "agent", sub-agent title prefix) — populated by runClaude
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tool_events' AND column_name='kind') THEN
    ALTER TABLE tool_events ADD COLUMN kind TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- Outbound communications log — every WhatsApp / email / Telegram message the agent
-- sends on behalf of the user. Append-only audit trail. Origin = perk name, agent,
-- sub-agent title prefix, or 'user' (manual UI action).
CREATE TABLE IF NOT EXISTS outbound_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL,           -- 'whatsapp' | 'email' | 'telegram'
  status TEXT NOT NULL,            -- 'sent' | 'error'
  recipient TEXT,                  -- jid / email / chatId
  recipient_name TEXT,             -- resolved display name
  subject TEXT,                    -- email subject (null for chat channels)
  body TEXT,                       -- full text (truncated to 16k by sender)
  origin TEXT,                     -- perk name, 'agent', 'subagent:<title>', 'user'
  error TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS outbound_log_user_ts_idx ON outbound_log(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS outbound_log_user_channel_idx ON outbound_log(user_id, channel, ts DESC);

CREATE TABLE IF NOT EXISTS plugins (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  version TEXT,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  install_path TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
