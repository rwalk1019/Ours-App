# Live backend

The household project already has its tables, RPCs, and `ours-auth` function. This draft does not replace them. `supabase/greenfield/0001_ours.sql` aborts if those tables exist. It is not in `supabase/migrations`.

The local server and the tests use a fixture with the same table and RPC names. Restarting it does not drop an existing local database. It is not connected to the live project.

## What the owner app calls

Passkeys go to `POST /functions/v1/ours-auth` with `{ "action": ... }`. The session token comes back in JSON and stays in memory for the tab. It is not written to browser storage.

Household reads and writes go to `POST /rest/v1/rpc/<name>` with the anon key when `VITE_SUPABASE_ANON_KEY` is set:

- `ours_get_state`, `ours_settings_presence`
- `ours_save_settings`, `ours_save_custom_item`, `ours_delete_custom_item`
- `ours_save_fix_rule`, `ours_delete_fix_rule`
- `ours_request_refresh`, `ours_sign_out`
- `ours_delete_passkey` is available to a signed-in session; the function refuses to delete the last passkey

`ours_settings_presence` is the optional function in `supabase/additive/ours_settings_presence.sql`. It does not change tables. Until it is installed, the screen treats tithing and the weekly target as unsaved, because `ours_get_state` fills 10% and $150 when those rows are missing.

Uploads stay on `ours_admin_upload_snapshot`. The browser does not call it. `scripts/prepare-live-upload.ts` only checks that a file has an accounts array and refuses to post.

## Auth contract the fixture follows

- Setup codes are `XXXX-XXXX-XXXX`, stored as SHA-256 hex of that dashed form, and last 24 hours.
- Backup codes are ten `XXXXX-XXXXX` values, same hash, single use.
- Replacing backup codes requires a signed-in session. The screen also asks before it calls. The deployed action itself replaces every code as soon as it receives a valid session.
- Challenges last five minutes and are marked used on the first verify.
- Passkey checks require user verification and an origin in `OURS_ORIGINS`. There is no fallback host in this draft.
- Sessions last 30 days. `ours_get_state` slides that window. `ours_sign_out` deletes that token and any already expired sessions.
- Failed attempts are limited to 20 per hour on setup, passkey verify, and backup login. Issuing a passkey challenge is not throttled in the deployed function; this fixture matches that.

## Findings in the deployed function

These are observations from the sanitized source. This draft does not change the deployed function.

- CORS sets `Access-Control-Allow-Origin` to the first configured origin when the request origin is not on the list. Browsers still will not expose the response to the other site, because the header is not that site's origin and credentials are not used. The header should be omitted instead.
- `reg_verify` returns the verifier's exception text to the client. The local fixture returns "Passkey check failed."
- A sign counter that moves backwards fails the assertion and leaves the passkey in place.
- Backup-code replacement deletes every code before the insert. A failed insert would leave none. It is not wrapped in a transaction in the deployed function.
- `search_path` on the definer functions is `public, pg_temp`. It is pinned, which blocks a caller from changing it, and `public` is first. Anon cannot create objects there with the current grants.
- Row level security is enabled and not forced. Anon has no table grants. The definer functions are the read path, and each public one checks a session token or the uploader key except `ours_sign_out`, which only deletes the hashed token plus expired rows.

## Still required to host the static app

The deployed `OURS_RP_ID` and `OURS_ORIGINS` were redacted and were not read. Do not guess them. Build the web app with:

- `VITE_OURS_AUTH_URL` = the `ours-auth` function URL
- `VITE_OURS_RPC_BASE` = `https://<project>.supabase.co/rest/v1/rpc`
- `VITE_SUPABASE_ANON_KEY` = the anon key, not the service role

The page origin must be one of the function's configured origins, or passkey checks fail. Serve the headers in `deploy/recommended-headers.txt`, and include the Supabase origin in `connect-src`. Passkeys need HTTPS on that origin. Applying `ours_settings_presence` is what lets the screen tell a saved percent from the 10% fallback.
