-- Local fixture for the sanitized RPC contract. Not a migration and not applied to live.
create or replace function public.ours__hash(p text) returns text
language sql immutable
set search_path = pg_catalog
as $$ select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;

create or replace function public.ours__items() returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'kind', kind, 'value', value, 'note', note, 'updated_at', updated_at
  ) order by created_at), '[]'::jsonb) from ours_custom_items
$$;

create or replace function public.ours__rules() returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'match', match, 'category', category, 'updated_at', updated_at
  ) order by lower(match)), '[]'::jsonb) from ours_fix_rules
$$;

create or replace function public.ours__settings() returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'weekly_target', coalesce((select value from ours_settings where key = 'weekly_target'), '150'::jsonb),
    'tithing_percent', coalesce((select value from ours_settings where key = 'tithing_percent'), '10'::jsonb),
    'tithing_category', coalesce((select value from ours_settings where key = 'tithing_category'), '"Tithing"'::jsonb)
  )
$$;

create or replace function public.ours__require_session(p_token text) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  if p_token is null or length(p_token) < 30 then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  update ours_sessions
     set last_seen_at = now(), expires_at = greatest(expires_at, now() + interval '30 days')
   where token_hash = ours__hash(p_token) and expires_at > now();
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'not signed in' using errcode = '28000';
  end if;
end $$;

create or replace function public.ours__require_uploader(p_key text) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_key is null or not exists (
    select 1 from ours_settings where key = 'uploader_key_hash' and value #>> '{}' = ours__hash(p_key)
  ) then
    raise exception 'bad uploader key' using errcode = '28000';
  end if;
end $$;

create or replace function public.ours_get_state(p_token text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare s record;
begin
  perform ours__require_session(p_token);
  select id, created_at, as_of, data into s from ours_snapshots order by as_of desc, id desc limit 1;
  return jsonb_build_object(
    'snapshot', case when s.id is null then null else jsonb_build_object('id', s.id, 'as_of', s.as_of, 'uploaded_at', s.created_at, 'data', s.data) end,
    'settings', ours__settings(),
    'fix_rules', ours__rules(),
    'custom_items', ours__items(),
    'refresh', (select jsonb_build_object('id', id, 'requested_at', requested_at, 'status', status, 'closed_at', closed_at, 'note', note)
                  from ours_refresh_requests order by id desc limit 1),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'device_name', device_name, 'created_at', created_at, 'last_used_at', last_used_at) order by created_at), '[]'::jsonb) from ours_passkey_credentials),
    'backup_codes_left', (select count(*) from ours_backup_codes where used_at is null),
    'server_time', now()
  );
end $$;

create or replace function public.ours_request_refresh(p_token text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r ours_refresh_requests;
begin
  perform ours__require_session(p_token);
  select * into r from ours_refresh_requests where status = 'open' order by id desc limit 1;
  if r.id is null then
    insert into ours_refresh_requests default values returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.ours_save_custom_item(p_token text, p_item jsonb) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r ours_custom_items;
begin
  perform ours__require_session(p_token);
  if p_item ? 'id' and nullif(p_item->>'id', '') is not null then
    update ours_custom_items set name = btrim(p_item->>'name'), kind = p_item->>'kind',
      value = (p_item->>'value')::numeric, note = nullif(btrim(coalesce(p_item->>'note', '')), ''), updated_at = now()
     where id = (p_item->>'id')::uuid returning * into r;
    if r.id is null then raise exception 'item not found'; end if;
  else
    insert into ours_custom_items(name, kind, value, note)
    values (btrim(p_item->>'name'), p_item->>'kind', (p_item->>'value')::numeric, nullif(btrim(coalesce(p_item->>'note', '')), ''))
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.ours_delete_custom_item(p_token text, p_id uuid) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform ours__require_session(p_token);
  delete from ours_custom_items where id = p_id;
  return found;
end $$;

create or replace function public.ours_save_fix_rule(p_token text, p_match text, p_category text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r ours_fix_rules;
begin
  perform ours__require_session(p_token);
  insert into ours_fix_rules(match, category) values (btrim(p_match), btrim(p_category))
  on conflict (lower(match)) do update set category = excluded.category, updated_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.ours_delete_fix_rule(p_token text, p_id uuid) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform ours__require_session(p_token);
  delete from ours_fix_rules where id = p_id;
  return found;
end $$;

create or replace function public.ours_delete_passkey(p_token text, p_id text) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform ours__require_session(p_token);
  if (select count(*) from ours_passkey_credentials) <= 1 then
    raise exception 'cannot remove the only passkey';
  end if;
  delete from ours_passkey_credentials where id = p_id;
  return found;
end $$;

create or replace function public.ours_save_settings(p_token text, p_settings jsonb) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v numeric; c text;
begin
  perform ours__require_session(p_token);
  if p_settings ? 'weekly_target' then
    v := (p_settings->>'weekly_target')::numeric;
    if v < 0 or v > 1000000 then raise exception 'weekly target out of range'; end if;
    insert into ours_settings(key, value, updated_at) values ('weekly_target', to_jsonb(round(v, 2)), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_settings ? 'tithing_percent' then
    v := (p_settings->>'tithing_percent')::numeric;
    if v < 0 or v > 100 then raise exception 'tithing percent must be 0-100'; end if;
    insert into ours_settings(key, value, updated_at) values ('tithing_percent', to_jsonb(round(v, 2)), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_settings ? 'tithing_category' then
    c := btrim(p_settings->>'tithing_category');
    if c is null or length(c) < 1 or length(c) > 40 then raise exception 'bad tithing category'; end if;
    insert into ours_settings(key, value, updated_at) values ('tithing_category', to_jsonb(c), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return ours__settings();
end $$;

create or replace function public.ours_sign_out(p_token text) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  delete from ours_sessions where token_hash = ours__hash(p_token);
  delete from ours_sessions where expires_at < now();
  return true;
end $$;

create or replace function public.ours_admin_upload_snapshot(p_key text, p_as_of timestamptz, p_data jsonb, p_report jsonb) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare new_id bigint; closed int; removed int;
begin
  perform ours__require_uploader(p_key);
  if jsonb_typeof(p_data->'accounts') <> 'array' or jsonb_array_length(p_data->'accounts') = 0 then
    raise exception 'snapshot has no accounts; refusing to replace real data';
  end if;
  insert into ours_snapshots(as_of, data, report) values (p_as_of, p_data, p_report) returning id into new_id;
  with d as (
    delete from ours_snapshots
    where id not in (select id from ours_snapshots order by as_of desc, id desc limit 5)
    returning 1
  )
  select count(*) into removed from d;
  update ours_refresh_requests set status = 'done', closed_at = now(), note = 'snapshot ' || new_id where status = 'open';
  get diagnostics closed = row_count;
  return jsonb_build_object('snapshot_id', new_id, 'closed_requests', closed, 'removed_old', removed, 'kept', (select count(*) from ours_snapshots));
end $$;

create or replace function public.ours_admin_close_requests(p_key text, p_status text, p_note text) returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  perform ours__require_uploader(p_key);
  if p_status not in ('done', 'failed') then raise exception 'bad status'; end if;
  update ours_refresh_requests set status = p_status, closed_at = now(), note = left(p_note, 200) where status = 'open';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.ours_admin_get_config(p_key text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform ours__require_uploader(p_key);
  return jsonb_build_object(
    'settings', ours__settings(),
    'fix_rules', ours__rules(),
    'custom_items_count', (select count(*) from ours_custom_items),
    'open_refresh_requests', (select count(*) from ours_refresh_requests where status = 'open'),
    'latest_as_of', (select max(as_of) from ours_snapshots)
  );
end $$;

create or replace function public.ours_admin_latest_report(p_key text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform ours__require_uploader(p_key);
  return (select jsonb_build_object('as_of', as_of, 'report', report) from ours_snapshots order by as_of desc, id desc limit 1);
end $$;

revoke all on function public.ours__hash(text) from public, anon, authenticated;
revoke all on function public.ours__items() from public, anon, authenticated;
revoke all on function public.ours__rules() from public, anon, authenticated;
revoke all on function public.ours__settings() from public, anon, authenticated;
revoke all on function public.ours__require_session(text) from public, anon, authenticated;
revoke all on function public.ours__require_uploader(text) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'ours_get_state(text)',
    'ours_request_refresh(text)',
    'ours_save_custom_item(text, jsonb)',
    'ours_delete_custom_item(text, uuid)',
    'ours_save_fix_rule(text, text, text)',
    'ours_delete_fix_rule(text, uuid)',
    'ours_delete_passkey(text, text)',
    'ours_save_settings(text, jsonb)',
    'ours_sign_out(text)',
    'ours_admin_upload_snapshot(text, timestamptz, jsonb, jsonb)',
    'ours_admin_close_requests(text, text, text)',
    'ours_admin_get_config(text)',
    'ours_admin_latest_report(text)'
  ]
  loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated', fn);
  end loop;
end $$;
