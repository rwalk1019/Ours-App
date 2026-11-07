-- GREENFIELD DRAFT ONLY. Not the live Ours project.
-- If any live table is already present this script stops before creating or changing anything.
do $$
begin
  if to_regclass('public.ours_settings') is not null
     or to_regclass('public.ours_snapshots') is not null
     or to_regclass('public.ours_passkey_credentials') is not null
     or to_regclass('public.ours_device_setup_codes') is not null
     or to_regclass('public.ours_backup_codes') is not null then
    raise exception 'greenfield schema refused: existing Ours tables were left untouched';
  end if;
end $$;

-- Draft-only household schema.
-- Table names are exclusively ours_*.
-- Row level security is forced and no policies are created, so anon and authenticated
-- roles cannot read or write these tables through the Data API.
-- The edge function connects with a role that bypasses RLS (service_role or postgres).
-- The browser never receives that role or its key.

CREATE TABLE ours_categories (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  system boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  schema_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  balances_as_of timestamptz,
  transaction_count integer NOT NULL DEFAULT 0,
  account_count integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE ours_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('depository', 'credit', 'loan', 'investment', 'other')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  tithing_bps integer CHECK (tithing_bps IS NULL OR (tithing_bps >= 0 AND tithing_bps <= 10000)),
  webauthn_user_handle text,
  current_snapshot_id uuid REFERENCES ours_snapshots (id),
  last_import_completed_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES ours_snapshots (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES ours_accounts (id),
  as_of timestamptz NOT NULL,
  asset_cents bigint NOT NULL,
  owed_cents bigint NOT NULL CHECK (owed_cents >= 0),
  available_cents bigint,
  note text,
  UNIQUE (snapshot_id, account_id)
);

CREATE TABLE ours_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES ours_accounts (id),
  posted_on date NOT NULL,
  posted_at timestamptz,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  direction text NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  pending boolean NOT NULL DEFAULT false,
  voided boolean NOT NULL DEFAULT false,
  merchant_label text,
  description text,
  provider_kind text CHECK (provider_kind IS NULL OR provider_kind IN ('income', 'expense', 'refund', 'transfer', 'debt_payment')),
  kind text NOT NULL CHECK (kind IN ('income', 'expense', 'refund', 'transfer', 'debt_payment', 'unreviewed')),
  kind_source text NOT NULL CHECK (kind_source IN ('user', 'rule', 'provider', 'matcher', 'unreviewed')),
  category_id uuid REFERENCES ours_categories (id),
  category_source text CHECK (category_source IS NULL OR category_source IN ('user', 'rule')),
  user_locked boolean NOT NULL DEFAULT false,
  review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_snapshot_id uuid REFERENCES ours_snapshots (id) ON DELETE SET NULL,
  last_snapshot_id uuid REFERENCES ours_snapshots (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ours_transactions_posted_on_idx ON ours_transactions (posted_on);

CREATE TABLE ours_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES ours_categories (id),
  period text NOT NULL CHECK (period IN ('week', 'month', 'year')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, period)
);

CREATE TABLE ours_fix_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern text NOT NULL CHECK (char_length(pattern) BETWEEN 1 AND 80),
  match_field text NOT NULL CHECK (match_field IN ('merchant', 'description')),
  category_id uuid NOT NULL REFERENCES ours_categories (id),
  kind_override text CHECK (kind_override IS NULL OR kind_override IN ('income', 'expense', 'refund', 'transfer', 'debt_payment', 'unreviewed')),
  priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_custom_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('asset', 'liability')),
  role text NOT NULL CHECK (role IN ('house', 'car', 'loan', 'other')),
  value_cents bigint NOT NULL CHECK (value_cents >= 0),
  as_of date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_tithing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_tithing_coverage (
  week_start date PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_refresh_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  snapshot_id uuid REFERENCES ours_snapshots (id) ON DELETE SET NULL
);

CREATE INDEX ours_refresh_requests_pending_idx ON ours_refresh_requests (requested_at) WHERE status = 'pending';

CREATE TABLE ours_report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  period_kind text NOT NULL CHECK (period_kind IN ('week', 'month', 'year')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_setup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('device_setup', 'recovery')),
  expires_at timestamptz,
  reserved_until timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id text NOT NULL UNIQUE,
  public_key_b64 text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports jsonb NOT NULL DEFAULT '[]'::jsonb,
  device_label text NOT NULL DEFAULT 'This device',
  clone_suspected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE ours_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  rp_id text NOT NULL,
  origin text NOT NULL,
  setup_code_id uuid REFERENCES ours_setup_codes (id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  credential_id uuid NOT NULL REFERENCES ours_credentials (id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('device_setup', 'recovery', 'authentication', 'registration')),
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_import_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ours_report_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ours_categories (id, name, system, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Groceries', true, 1),
  ('00000000-0000-4000-8000-000000000002', 'Household', true, 2),
  ('00000000-0000-4000-8000-000000000003', 'Transport', true, 3),
  ('00000000-0000-4000-8000-000000000004', 'Utilities', true, 4),
  ('00000000-0000-4000-8000-000000000005', 'Health', true, 5),
  ('00000000-0000-4000-8000-000000000006', 'Other', true, 6);

INSERT INTO ours_settings (id) VALUES (1);

CREATE TABLE ours_schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ours_schema_migrations (id) VALUES ('0001_ours.sql');

DO $$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOR table_name IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'ours\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
    END IF;
  END LOOP;
END $$;
