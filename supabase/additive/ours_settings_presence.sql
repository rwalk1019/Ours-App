-- Proposed only. Do not apply this from the app, and do not run it against the
-- live database until the owner reviews it. It creates no tables and changes no rows.
--
-- ours_get_state returns settings from ours__settings(). That function currently
-- omits tithing_period, tithing_income_sources, and tithing_payment_match.
-- The replacement below adds those three keys with no fallback value.
-- weekly_target, tithing_percent, and tithing_category keep their existing
-- fallbacks so current callers still see 150, 10, and "Tithing" when unset.
-- ours_settings_presence returns the raw jsonb, null when the row is absent,
-- so a fallback is not shown as a saved choice.

create or replace function public.ours__settings() returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'weekly_target', coalesce((select value from public.ours_settings where key = 'weekly_target'), '150'::jsonb),
    'tithing_percent', coalesce((select value from public.ours_settings where key = 'tithing_percent'), '10'::jsonb),
    'tithing_category', coalesce((select value from public.ours_settings where key = 'tithing_category'), '"Tithing"'::jsonb),
    'tithing_period', (select value from public.ours_settings where key = 'tithing_period'),
    'tithing_income_sources', (select value from public.ours_settings where key = 'tithing_income_sources'),
    'tithing_payment_match', (select value from public.ours_settings where key = 'tithing_payment_match')
  )
$$;

revoke all on function public.ours__settings() from public, anon, authenticated;

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
    'tithing_category', (select value from public.ours_settings where key = 'tithing_category'),
    'tithing_period', (select value from public.ours_settings where key = 'tithing_period'),
    'tithing_income_sources', (select value from public.ours_settings where key = 'tithing_income_sources'),
    'tithing_payment_match', (select value from public.ours_settings where key = 'tithing_payment_match')
  );
end $$;

revoke all on function public.ours_settings_presence(text) from public;
grant execute on function public.ours_settings_presence(text) to anon, authenticated;
