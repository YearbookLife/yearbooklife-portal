-- =============================================================================
-- PortraitPop photographer licensing: database tables
--
-- HOW TO RUN: Supabase -> your project -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run more than once.
--
-- These tables are used ONLY by the photographer licensing program (the /pp
-- pages and the api/pp-*.ts routes). The customer dashboard never reads them,
-- and photographer/admin accounts here are NOT Supabase Auth users, so the
-- dashboard's invite and stale-user cleanup jobs can never touch them.
--
-- Row Level Security is switched on with no policies, so the public "anon" key
-- the dashboard hands to browsers cannot read or change any of this. Only the
-- server (service role key) can.
-- =============================================================================

create extension if not exists pgcrypto;

-- A photographer who buys licenses from YearbookLife.
create table if not exists pp_photographers (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  name        text not null default '',
  company     text not null default '',
  phone       text not null default '',
  status      text not null default 'active' check (status in ('active', 'suspended')),
  notes       text not null default '',
  created_at  timestamptz not null default now()
);

-- One row per purchase, so there is a record of what was invoiced.
create table if not exists pp_orders (
  id               uuid primary key default gen_random_uuid(),
  photographer_id  uuid not null references pp_photographers(id) on delete cascade,
  quantity         integer not null check (quantity > 0),
  unit_price       numeric(10,2) not null,
  total            numeric(10,2) not null,
  note             text not null default '',
  created_by       text not null default '',
  created_at       timestamptz not null default now()
);

-- One row per license. A license is one school.
--   available -> bought, not yet sent to a school (never expires)
--   invited   -> sent to a school admin, admin has not signed in yet
--   active    -> admin has signed in; good for 60 days from that moment
--   revoked   -> photographer removed it, or staff cancelled it
-- "Expired" is not stored: it is an active license whose expires_at has passed.
create table if not exists pp_licenses (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,           -- stamped into every exported PDF
  photographer_id   uuid not null references pp_photographers(id) on delete cascade,
  order_id          uuid references pp_orders(id) on delete set null,
  status            text not null default 'available'
                      check (status in ('available', 'invited', 'active', 'revoked')),
  school_name       text not null default '',
  school_city       text not null default '',
  school_state      text not null default '',
  school_zip        text not null default '',
  admin_name        text not null default '',
  admin_email       text not null default '',
  invited_at        timestamptz,
  activated_at      timestamptz,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  reminder_sent_at  timestamptz,
  ybl_flagged_at    timestamptz,                    -- school later found in YearbookLife HubSpot
  ybl_flag_detail   text not null default '',
  session_id        text,                           -- only ONE live sign-in per license
  devices           jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists pp_licenses_photographer_idx on pp_licenses (photographer_id);
create index if not exists pp_licenses_admin_email_idx on pp_licenses (lower(admin_email));
create index if not exists pp_licenses_status_idx on pp_licenses (status);

-- Emailed sign-in links. Only a hash of the token is stored.
create table if not exists pp_login_tokens (
  token_hash   text primary key,
  email        text not null,
  role         text not null check (role in ('photographer', 'admin', 'staff')),
  license_id   uuid references pp_licenses(id) on delete cascade,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists pp_login_tokens_email_idx on pp_login_tokens (lower(email));

-- Usage log: sign-ins, tool opens, exports, blocked attempts. No student data.
create table if not exists pp_events (
  id               bigserial primary key,
  at               timestamptz not null default now(),
  kind             text not null,
  license_id       uuid references pp_licenses(id) on delete set null,
  photographer_id  uuid references pp_photographers(id) on delete set null,
  email            text not null default '',
  ip_hash          text not null default '',
  device           text not null default '',
  detail           jsonb not null default '{}'::jsonb
);
create index if not exists pp_events_at_idx on pp_events (at desc);
create index if not exists pp_events_license_idx on pp_events (license_id, at desc);

-- Lock everything down to the server only.
alter table pp_photographers enable row level security;
alter table pp_orders        enable row level security;
alter table pp_licenses      enable row level security;
alter table pp_login_tokens  enable row level security;
alter table pp_events        enable row level security;

-- Takes one of a photographer's unused licenses and marks it 'invited'. Done in
-- the database in one step so two clicks at the same moment can't grab the same
-- license, and a photographer can never send more licenses than they bought.
create or replace function pp_claim_license(p_photographer uuid)
returns uuid
language sql
as $$
  update pp_licenses
     set status = 'invited'
   where id = (
     select id from pp_licenses
      where photographer_id = p_photographer and status = 'available'
      order by created_at
      limit 1
      for update skip locked
   )
  returning id;
$$;
revoke all on function pp_claim_license(uuid) from public, anon, authenticated;

-- The server's key (service_role) needs these. Supabase usually grants them
-- automatically; stating them here makes sure.
grant select, insert, update, delete on pp_photographers, pp_orders, pp_licenses, pp_login_tokens, pp_events to service_role;
grant usage, select on sequence pp_events_id_seq to service_role;
grant execute on function pp_claim_license(uuid) to service_role;
