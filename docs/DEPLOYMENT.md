# Deployment

The live Supabase project is already the backend. Do not apply `supabase/greenfield/0001_ours.sql` to it, and do not deploy `supabase/functions/ours-api`. That entry refuses to start. `ours-auth` and `ours_admin_upload_snapshot` stay as they are.

## Still required

1. Confirm the deployed function secrets `OURS_RP_ID` and `OURS_ORIGINS`. Their values were redacted in the compatibility export and were not read. Do not substitute a guessed host.
2. Build the static app with `VITE_OURS_AUTH_URL`, `VITE_OURS_RPC_BASE`, and `VITE_SUPABASE_ANON_KEY`. Use the anon key, not the service role. The page origin has to be on `OURS_ORIGINS`, over HTTPS, or passkey checks fail.
3. Publish that build with `deploy/recommended-headers.txt`. Add the Supabase origin to `connect-src`.
4. Optionally apply `supabase/additive/ours_settings_presence.sql`. It only adds a function. Until then, the screen will not treat 10% or $150 as saved settings.
5. Keep snapshot uploads on the existing admin RPC. `scripts/prepare-live-upload.ts` does not post.
6. Keep the owner email and the report schedule outside this repo. Nothing here sends mail.

## Explicitly not done

- No schema was applied to the live database.
- No function was deployed.
- No snapshot, key, hash, or row was copied into this repo.
- The local server uses `.data/live` and a synthetic fixture only.

Until those steps are done, the running app is the local development server or the sample household, not the household’s books.
