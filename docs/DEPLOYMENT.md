# Deployment

The live Supabase project is already the backend. Do not apply `supabase/greenfield/0001_ours.sql` to it, and do not deploy `supabase/functions/ours-api`. That entry refuses to start. Snapshot upload stays on `ours_admin_upload_snapshot`.

GitHub Pages serves the static app at https://rwalk1019.github.io/Ours-App/ from `.github/workflows/pages.yml`. The workflow sets the Vite base to `/Ours-App/`, the auth and RPC URLs, and the public Supabase publishable key as `VITE_SUPABASE_ANON_KEY`. That key is not a secret. Do not put a service-role key there.

## Still required

1. In the ours-app repository, set Settings → Pages → Build and deployment → Source to GitHub Actions, if it is not already.
2. Deploy `supabase/functions/ours-auth/index.ts` yourself. Set `OURS_RP_ID` to `rwalk1019.github.io` and `OURS_ORIGINS` to `https://rwalk1019.github.io`. The file defaults to those values and reads `OURS_DATABASE_URL` or `SUPABASE_DB_URL` from the function environment.
3. Review and apply `supabase/additive/ours_settings_presence.sql` only if you want `ours_get_state` and the presence check to return `tithing_period`, `tithing_income_sources`, and `tithing_payment_match`. Until then, the screen does not treat 10% or $150 as saved settings and does not guess a month.
4. Keep snapshot uploads on the existing admin RPC. `scripts/prepare-live-upload.ts` does not post.
5. Keep the owner email and the report schedule outside this repo. Nothing here sends mail.

## Explicitly not done

- No schema was applied to the live database.
- No function was deployed.
- No snapshot, key, hash, or row was copied into this repo.
- The local server uses `.data/live` and a synthetic fixture only.

Until those steps are done, the running app is the local development server or the sample household, not the household’s books.
