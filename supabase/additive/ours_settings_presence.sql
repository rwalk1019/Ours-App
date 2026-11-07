-- Optional additive function. Does not alter or delete existing tables or rows.
-- Not in supabase/migrations, so it is not applied by a migration push.
-- Deploy only after review. It lets the owner UI tell a saved percent from the
-- server fallback of 10 and a saved weekly target from the fallback of 150.
create or replace function public.ours_settings_presence(p_token text) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ours__require_session(p_token);
  return jsonb_build_object(
    'weekly_target', (select value from public.ours_settings where key = 'weekly_target'),
    'tithing_percent', (select value from public.ours_settings where key = 'tithing_percent'),
    'tithing_category', (select value from public.ours_settings where key = 'tithing_category')
  );
end $$;

revoke all on function public.ours_settings_presence(text) from public;
grant execute on function public.ours_settings_presence(text) to anon, authenticated;
