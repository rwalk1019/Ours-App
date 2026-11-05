# Deployment

Ours is not deployed. No Supabase project is linked, no host was chosen, and no mail or bank call was made from this environment.

## Still required

1. Create a Supabase project you control, or another Postgres 15+ database. Apply `supabase/migrations/0001_ours.sql`. Confirm the anon key cannot `select` from `ours_settings`. The migration enables and forces RLS, creates no policies, and revokes table privileges from `anon` and `authenticated` when those roles exist.
2. Deploy `supabase/functions/ours-api` with `verify_jwt = false` and the secrets in `docs/CONFIGURATION.md`. The function connects with `postgres` (`npm:postgres`) and `OURS_DATABASE_URL`. `npm run build:function` bundles our TypeScript to `dist/ours-api.js` and leaves npm packages external so the Supabase bundler can install them. That command does not deploy.
3. Build the web app with `VITE_API_BASE` set to the function URL. Publish the `apps/web/dist` files on a static host you already operate. Put the headers in `deploy/recommended-headers.txt` on that host. The production HTML also includes a Content-Security-Policy meta tag. `frame-ancestors` and HSTS only work as real headers, so the meta tag is not a complete substitute.
4. Open the site on the exact origin in `OURS_ORIGINS`. The relying party id must be that site’s domain. Passkeys need HTTPS. A platform authenticator uses Face ID, Touch ID, or a PIN when the device has one. This app does not claim every phone has Face ID.
5. From a machine that can reach the database, insert a device setup code with the production pepper and give it to the owner out of band. The local `npm run setup-code` command only writes to `.data/pglite`.
6. Issue an import token and a report token the same way. Store them with the coordinator, not in this repo.
7. Point the existing twice-daily refresh, Monday report, first-of-month report, and January 1 report at the import command and `POST /api/reports/generate`. Keep the owner’s email address in that mailer. This repo will not send the message.
8. Map the Finance connector export into `ours.snapshot` version 1 or `finance-connector-export` version 1. The connector’s field names were not available here. Do not put a Plaid secret or a Finance OAuth client on the web host or in this repository.

## Explicitly not done

- No GitHub mirror and no paid host.
- No live Supabase, so migrations have been executed only against embedded Postgres in tests.
- No Finance OAuth and no live balances.
- No email send, no recipient, and no new schedule.
- No service-role key, pepper, or import token committed.

Until those steps are done, the running app is the local development server or the sample household, not the household’s books.
