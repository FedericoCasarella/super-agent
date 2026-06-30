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

-- Client update messages: drafted by the "arm" from ClickUp tasks in status
-- "mandare mex cliente", approved by Marco on Telegram, sent to the client's
-- WhatsApp group. body_edited holds Marco's edited version (graduation signal).
-- task_ids = the ClickUp tasks batched into this one message (per client).
CREATE TABLE IF NOT EXISTS client_msg_drafts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clickup_list_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  wa_group_jid TEXT,                 -- null => no verified mapping, draft held
  task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  body TEXT NOT NULL,
  body_edited TEXT,                  -- Marco's edit at approval, if any
  preview_link TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','sent','held','error','queued')),
  telegram_message_id BIGINT,
  telegram_chat_id BIGINT,
  decided_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_msg_drafts_user_status_idx ON client_msg_drafts(user_id, status, created_at DESC);
-- Allow 'queued' (deferred send outside the Mon-Fri 9:00-18:30 window) on
-- tables created before this status existed.
ALTER TABLE client_msg_drafts DROP CONSTRAINT IF EXISTS client_msg_drafts_status_check;
ALTER TABLE client_msg_drafts ADD CONSTRAINT client_msg_drafts_status_check CHECK (status IN ('pending','approved','denied','sent','held','error','queued'));

-- Task Supervisor: traccia da quando una task ClickUp è nel suo stato attuale
-- (ClickUp time-in-status non disponibile). `since` = transizione osservata
-- (seed iniziale = date_updated). `last_nudged_at` per la cadenza dei nudge.
CREATE TABLE IF NOT EXISTS task_status_seen (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  since TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_nudged_at TIMESTAMPTZ
);
-- Step 2b: tracciamento auto-follow-up al cliente (waiting feedback client).
ALTER TABLE task_status_seen ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
ALTER TABLE task_status_seen ADD COLUMN IF NOT EXISTS followup_count INT NOT NULL DEFAULT 0;

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

-- Outgoing WA message source: 'user' (typed manually) or 'ai' (drafted by suggestion).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_messages' AND column_name='source') THEN
    ALTER TABLE wa_messages ADD COLUMN source TEXT;
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

-- =====================================================================
-- Custom Agents + Teams + Team Tasks
-- =====================================================================
-- Custom agent = user-defined persona with system prompt, skill (tool/connector) allowlist,
-- model preference. Skills are a JSONB array of tool names (e.g. ["mcp__super_agent__people_search","Read","Grep"]).
CREATE TABLE IF NOT EXISTS custom_agents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,                       -- short label like "Lead Researcher"
  description TEXT,
  system_prompt TEXT NOT NULL,
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["Read","Grep","mcp__super_agent__people_search", ...]
  model TEXT,                      -- e.g. claude-sonnet-4-6 / claude-opus-4-7 / null = default
  icon TEXT,                       -- emoji or URL
  color TEXT,                      -- hex
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custom_agents_user_idx ON custom_agents(user_id) WHERE archived=false;
CREATE UNIQUE INDEX IF NOT EXISTS custom_agents_user_name_uniq ON custom_agents(user_id, lower(name));

-- Team = ordered group of agents with hierarchy (reports_to within team).
CREATE TABLE IF NOT EXISTS agent_teams (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_teams_user_idx ON agent_teams(user_id) WHERE archived=false;
CREATE UNIQUE INDEX IF NOT EXISTS agent_teams_user_name_uniq ON agent_teams(user_id, lower(name));

CREATE TABLE IF NOT EXISTS agent_team_members (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES agent_teams(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES custom_agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',  -- 'lead' | 'member'
  reports_to BIGINT REFERENCES custom_agents(id) ON DELETE SET NULL,  -- supervisor within team
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_team_members_team_idx ON agent_team_members(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_team_members_uniq ON agent_team_members(team_id, agent_id);

-- Task assigned to a team OR a single agent.
CREATE TABLE IF NOT EXISTS team_tasks (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id BIGINT REFERENCES agent_teams(id) ON DELETE SET NULL,
  agent_id BIGINT REFERENCES custom_agents(id) ON DELETE SET NULL,  -- single-agent execution
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error | cancelled
  result TEXT,
  error TEXT,
  cost_usd NUMERIC(10,6),
  duration_ms INTEGER,
  created_by TEXT,           -- 'user' | 'telegram' | 'agent'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_tasks_user_idx ON team_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS team_tasks_status_idx ON team_tasks(user_id, status);

-- Every interaction inside a task execution: delegations, reports, messages between agents.
CREATE TABLE IF NOT EXISTS team_task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_agent_id BIGINT REFERENCES custom_agents(id) ON DELETE SET NULL,
  to_agent_id BIGINT REFERENCES custom_agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,        -- 'delegate' | 'report' | 'message' | 'tool' | 'start' | 'finish' | 'error'
  content TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS team_task_events_task_idx ON team_task_events(task_id, id);

-- =====================================================================
-- FLOWS — user-defined automation: triggers → sequence of action steps
-- =====================================================================
CREATE TABLE IF NOT EXISTS flows (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flows_user_idx ON flows(user_id) WHERE archived=false;

-- A flow can have multiple triggers (OR-semantics: any one fires the run)
CREATE TABLE IF NOT EXISTS flow_triggers (
  id BIGSERIAL PRIMARY KEY,
  flow_id BIGINT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  type TEXT NOT NULL,             -- 'whatsapp.received' | 'email.received' | 'voice.received' | 'telegram.received'
                                  -- | 'schedule.datetime' | 'schedule.cron'
                                  -- | 'agent.finished' | 'brain.node_added' | 'task.triggered' | 'perk.fired' | 'team.fired'
  config JSONB NOT NULL DEFAULT '{}'::jsonb,  -- type-specific (chat filter, cron expr, agent name, etc.)
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_triggers_flow_idx ON flow_triggers(flow_id);
CREATE INDEX IF NOT EXISTS flow_triggers_type_idx ON flow_triggers(type);

-- Ordered list of action steps
CREATE TABLE IF NOT EXISTS flow_steps (
  id BIGSERIAL PRIMARY KEY,
  flow_id BIGINT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,             -- 'agent.run' | 'telegram.notify' | 'team.run' | 'email.send'
                                  -- | 'whatsapp.send' | 'brain.write_note' | 'delay' | 'webhook' | 'condition'
  name TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS flow_steps_flow_idx ON flow_steps(flow_id, position);

CREATE TABLE IF NOT EXISTS flow_runs (
  id BIGSERIAL PRIMARY KEY,
  flow_id BIGINT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error | cancelled
  trigger_type TEXT,
  trigger_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flow_runs_flow_idx ON flow_runs(flow_id, id DESC);
CREATE INDEX IF NOT EXISTS flow_runs_user_idx ON flow_runs(user_id, id DESC);

CREATE TABLE IF NOT EXISTS flow_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_id BIGINT REFERENCES flow_steps(id) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,             -- 'start' | 'step.start' | 'step.done' | 'step.error' | 'finish' | 'error'
  content TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS flow_run_events_run_idx ON flow_run_events(run_id, id);

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

-- =====================================================================
-- Instagram DM connector (instagram-private-api). Mirrors wa_* shape.
-- thread_id   = IG conversation id (string)
-- user_ig_id  = IG numeric user id of the other party (PK helper)
-- =====================================================================
CREATE TABLE IF NOT EXISTS ig_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sender_ig_id TEXT NOT NULL,
  sender_username TEXT,
  sender_name TEXT,
  person_slug TEXT,
  from_me BOOLEAN NOT NULL DEFAULT false,
  text TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT 'text',
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  source TEXT,
  UNIQUE(user_id, msg_id)
);
CREATE INDEX IF NOT EXISTS ig_messages_user_thread_ts_idx ON ig_messages(user_id, thread_id, ts DESC);
CREATE INDEX IF NOT EXISTS ig_messages_user_ts_idx ON ig_messages(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS ig_messages_user_processed_idx ON ig_messages(user_id, processed_at);

CREATE TABLE IF NOT EXISTS ig_threads (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  title TEXT,
  is_group BOOLEAN NOT NULL DEFAULT false,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_activity TIMESTAMPTZ,
  auto_bonify BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, thread_id)
);
CREATE INDEX IF NOT EXISTS ig_threads_user_activity_idx ON ig_threads(user_id, last_activity DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS ig_threads_user_autobonify_idx ON ig_threads(user_id) WHERE auto_bonify=true;

CREATE TABLE IF NOT EXISTS ig_contacts (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ig_id TEXT NOT NULL,
  username TEXT,
  full_name TEXT,
  profile_pic_url TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, ig_id)
);
CREATE INDEX IF NOT EXISTS ig_contacts_user_username_idx ON ig_contacts(user_id, username);

-- IG auto-responder: when enabled on a thread, agent auto-replies to incoming
-- DMs trying to drive the conversation toward the goal text. Goal is the
-- user-supplied objective ("vendere consulenza", "qualifica lead", ecc.).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ig_threads' AND column_name='auto_responder') THEN
    ALTER TABLE ig_threads ADD COLUMN auto_responder BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE ig_threads ADD COLUMN auto_responder_goal TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ig_threads_user_autoresponder_idx ON ig_threads(user_id) WHERE auto_responder=true;

-- Follow-up tracking for auto-responder. When agent sends, schedule a check.
-- If counterpart still silent at follow_up_at, fire follow-up message and bump
-- count. Max 3 follow-ups per thread.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ig_threads' AND column_name='follow_up_at') THEN
    ALTER TABLE ig_threads ADD COLUMN follow_up_at TIMESTAMPTZ;
    ALTER TABLE ig_threads ADD COLUMN follow_up_count INT NOT NULL DEFAULT 0;
    ALTER TABLE ig_threads ADD COLUMN last_outbound_at TIMESTAMPTZ;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ig_threads_followup_idx ON ig_threads(user_id, follow_up_at) WHERE follow_up_at IS NOT NULL;

-- WA profile picture cache. Baileys returns a temporary URL; we store last
-- fetched value + ts so we can refresh stale ones (IG/WA rotate signed URLs).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_contacts' AND column_name='profile_pic_url') THEN
    ALTER TABLE wa_contacts ADD COLUMN profile_pic_url TEXT;
    ALTER TABLE wa_contacts ADD COLUMN profile_pic_fetched_at TIMESTAMPTZ;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- Manual brain-link per WA chat (or contact). No more auto-linking by phone;
-- user explicitly cables a chat to a Person via the UI.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_contacts' AND column_name='linked_person_slug') THEN
    ALTER TABLE wa_contacts ADD COLUMN linked_person_slug TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wa_contacts_linked_person_idx ON wa_contacts(user_id, linked_person_slug) WHERE linked_person_slug IS NOT NULL;

-- Per-chat user overrides: name + phone shown in UI. Survive every WA sync,
-- never overwritten by Baileys upsertContacts (it only touches `name`/`notify`).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wa_contacts' AND column_name='display_name') THEN
    ALTER TABLE wa_contacts ADD COLUMN display_name TEXT;
    ALTER TABLE wa_contacts ADD COLUMN display_phone TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- Brain snapshots: nightly copy of each vault + counts of nodes/links/files.
-- A snapshot row maps to a directory on disk holding the copied .md tree.
CREATE TABLE IF NOT EXISTS brain_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_name TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  snapshot_dir TEXT NOT NULL,
  file_count INT NOT NULL DEFAULT 0,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  neurons_count INT NOT NULL DEFAULT 0,
  links_count INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'cron',   -- 'cron' | 'manual'
  status TEXT NOT NULL DEFAULT 'ok',      -- 'ok' | 'error'
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_snapshots_user_created_idx ON brain_snapshots(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS brain_snapshots_user_vault_idx ON brain_snapshots(user_id, vault_name, created_at DESC);

-- =====================================================================
-- Mail client (IMAP + SMTP). Full message metadata for fast list/search;
-- bodies stored in TEXT cols. Attachments persisted to disk, paths in
-- mail_attachments. Thread grouping via in-reply-to / references chain.
-- =====================================================================
CREATE TABLE IF NOT EXISTS mail_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_label TEXT NOT NULL,            -- matches imap connector accounts[].label
  uid INT,                                -- IMAP UID (null for sent-via-SMTP rows)
  message_id TEXT,                        -- RFC822 Message-ID
  in_reply_to TEXT,
  refs TEXT[] NOT NULL DEFAULT '{}',     -- References chain
  thread_key TEXT,                        -- normalized key for grouping (first msg-id or subject hash)
  folder TEXT NOT NULL DEFAULT 'INBOX',
  direction TEXT NOT NULL DEFAULT 'in',   -- 'in' | 'out'
  from_addr TEXT,
  from_name TEXT,
  to_addrs TEXT[] NOT NULL DEFAULT '{}',
  cc_addrs TEXT[] NOT NULL DEFAULT '{}',
  bcc_addrs TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  preview TEXT,                           -- first ~280 chars of text body
  body_text TEXT,
  body_html TEXT,
  raw_size INT NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen BOOLEAN NOT NULL DEFAULT false,
  flagged BOOLEAN NOT NULL DEFAULT false,
  starred BOOLEAN NOT NULL DEFAULT false,
  trashed_at TIMESTAMPTZ,                 -- soft-delete
  -- IMAP UIDs are unique PER FOLDER, not per account — uid 3 exists in both
  -- INBOX and Sent. Constraint must include folder (see migrate fixups).
  UNIQUE(user_id, account_label, folder, uid)
);
CREATE INDEX IF NOT EXISTS mail_messages_user_ts_idx ON mail_messages(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS mail_messages_user_account_ts_idx ON mail_messages(user_id, account_label, ts DESC);
CREATE INDEX IF NOT EXISTS mail_messages_user_thread_idx ON mail_messages(user_id, thread_key);
CREATE INDEX IF NOT EXISTS mail_messages_user_folder_idx ON mail_messages(user_id, folder, ts DESC);
CREATE INDEX IF NOT EXISTS mail_messages_user_seen_idx ON mail_messages(user_id, seen);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  cid TEXT,                               -- Content-ID for inline images
  inline BOOLEAN NOT NULL DEFAULT false,
  path TEXT NOT NULL,                     -- absolute filesystem path
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_attachments_msg_idx ON mail_attachments(message_id);

-- Mail "bonifica" timestamp: when set, the message has been ingested into the
-- brain (vault note + people linking) by the user via the UI button. Skipped
-- by batch runs unless force=true.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mail_messages' AND column_name='bonified_at') THEN
    ALTER TABLE mail_messages ADD COLUMN bonified_at TIMESTAMPTZ;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS mail_messages_user_bonified_idx ON mail_messages(user_id, bonified_at);

-- Persisted IMAP folder cache. Fills on first /mail/folders call per account,
-- subsequent requests read from here so the UI never waits on an IMAP LIST
-- handshake. Background refresh is triggered when `updated_at` is older than
-- the freshness window in the service layer.
CREATE TABLE IF NOT EXISTS mail_folders (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_label TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  subscribed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_label, name)
);
CREATE INDEX IF NOT EXISTS mail_folders_user_account_idx ON mail_folders(user_id, account_label);

-- =====================================================================
-- Thought Analyzer (sess.8266) — diario cognitivo + knowledge graph
-- Pensieri come oggetti di prima classe: un messaggio nel flusso
-- conversazionale sparisce; un pensiero e' aggregabile nel tempo, che e'
-- la condizione necessaria per far emergere i loop ricorrenti.
-- =====================================================================
CREATE TABLE IF NOT EXISTS thoughts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  text TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT 'telegram',          -- telegram | voice | api
  emotion TEXT,                                   -- popolato dall'analisi leggera
  themes JSONB NOT NULL DEFAULT '[]'::jsonb,       -- string[]
  backlinks JSONB NOT NULL DEFAULT '[]'::jsonb,    -- string[] (titoli note vault)
  vault_path TEXT,                                -- nodo creato, relativo al vault
  analyzed BOOLEAN NOT NULL DEFAULT false,
  digested_on DATE                                -- data del digest che l'ha aggregato
);
CREATE INDEX IF NOT EXISTS thoughts_user_ts_idx ON thoughts(user_id, ts DESC);

-- Brain Consolidator — proposte di riscrittura del vault generate dal perk
-- notturno. NIENTE viene applicato automaticamente: l'utente approva/scarta
-- dal pannello in /brain. payload contiene tutto il necessario per l'apply.
CREATE TABLE IF NOT EXISTS brain_proposals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('merge','distill','prune','link','sync-pointer','sync-conflict','sync-missing')),
  title TEXT NOT NULL,                 -- riga breve mostrata in lista
  description TEXT,                    -- spiegazione della proposta
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- merge:        { sources: [path...], target_path, content } → scrive target, archivia sources
  -- distill:      { sources: [path...], target_path, content } → scrive profilo distillato, linka sources
  -- prune:        { sources: [path...] }                       → sposta in archive/<data>/
  -- link:         { path, related: [path...] }                 → aggiunge related: al frontmatter
  -- sync-conflict:{ group_key, entity, owner, values, stores } → riconcilia valori divergenti (Brain Sync)
  -- sync-pointer: { group_key, source_path, target, store }    → puntatore "fonte di verità" rotto (Brain Sync)
  -- sync-missing: { group_key, entity, owner, missing_in }     → fatto dell'owner non referenziato altrove (Brain Sync)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS brain_proposals_user_status_idx ON brain_proposals(user_id, status, created_at DESC);

-- Goals — obiettivi di lungo periodo con piano, KPI e steward settimanale.
-- Human-in-the-loop: il piano generato dall'agente resta in pending_plan
-- finché l'utente non lo approva; le azioni settimanali passano da
-- agent_proposals (keyboard Telegram ✅/❌).
CREATE TABLE IF NOT EXISTS goals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,                -- misurabile: "10 clienti AMPERA"
  deadline DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','done','archived')),
  -- kpis: [{id,name,unit,target,current,history:[{ts,value}]}]
  kpis JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- plan (approvato): { milestones:[{id,title,due,status}], notes }
  plan JSONB,
  -- pending_plan (proposta agente in attesa di approvazione umana)
  pending_plan JSONB,
  last_review_at TIMESTAMPTZ,             -- ultimo giro dello steward
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_user_status_idx ON goals(user_id, status);

-- Goal execution linkage — proposte e sub-agent spawnati per un obiettivo
-- portano il goal_id, così la pagina /goals/:id mostra l'esecuzione reale.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_proposals' AND column_name='goal_id') THEN
    ALTER TABLE agent_proposals ADD COLUMN goal_id BIGINT REFERENCES goals(id) ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sub_agents' AND column_name='goal_id') THEN
    ALTER TABLE sub_agents ADD COLUMN goal_id BIGINT REFERENCES goals(id) ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS sub_agents_goal_idx ON sub_agents(goal_id) WHERE goal_id IS NOT NULL;

-- Milestone-level agent linkage: which milestone a sub-agent works on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sub_agents' AND column_name='milestone_id') THEN
    ALTER TABLE sub_agents ADD COLUMN milestone_id TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_proposals' AND column_name='milestone_id') THEN
    ALTER TABLE agent_proposals ADD COLUMN milestone_id TEXT;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

-- =====================================================================
-- Automation meter — ledger delle transizioni di stato eseguite DALL'AGENTE
-- su task ClickUp. Append-only. È la sola fonte di verità per "chiusura
-- automatica": col token personale (pk_) ClickUp attribuisce ogni mossa a
-- Marco, quindi solo ciò che è loggato qui conta come azione dell'agente;
-- tutto il resto = manuale. Il rate rolling-7gg incrocia questo ledger con le
-- task realmente chiuse (API, date_closed/date_done).
-- =====================================================================
CREATE TABLE IF NOT EXISTS task_action_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_id TEXT NOT NULL,            -- ClickUp task id
  task_name TEXT,                   -- snapshot del nome (report storici fedeli)
  client_name TEXT,                 -- cliente risolto, se noto
  to_status TEXT NOT NULL,          -- stato impostato dalla PUT
  status_type TEXT,                 -- 'open' | 'custom' | 'done' | 'closed'
  is_close BOOLEAN NOT NULL DEFAULT false,  -- true se la mossa è in stato terminale
  origin TEXT,                      -- perk/'agent'/'subagent:<title>'
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS task_action_log_user_ts_idx ON task_action_log(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS task_action_log_close_idx ON task_action_log(user_id, is_close, ts DESC)
  WHERE is_close = true;
CREATE INDEX IF NOT EXISTS task_action_log_task_idx ON task_action_log(task_id);
