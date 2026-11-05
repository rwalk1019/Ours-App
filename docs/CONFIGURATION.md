# Configuration contract

Nothing in this list is filled in for a real household. Empty values in `.env.example` are placeholders. Do not commit real values.

## Production edge function

Set these as secrets on the function. Do not ship them in the static app.

| Name | Required | Meaning |
| --- | --- | --- |
| `OURS_ENV` | yes | `production` |
| `OURS_DATABASE_URL` | yes | Postgres connection string for a role that bypasses RLS, typically the Supabase `service_role` or `postgres` user. Not the anon key. Use the pooler with `prepare: false`, which the function already sets. |
| `OURS_CODE_PEPPER` | yes | At least 32 characters, not the development test pepper. Used only to HMAC setup and recovery codes. |
| `OURS_RP_ID` | yes | Domain of the site, such as `ours.example`. Not `localhost`. |
| `OURS_ORIGINS` | yes | Comma-separated bare https origins of the static app. Cookies and WebAuthn are checked against this list. |
| `OURS_COOKIE_SAMESITE` | no | `Strict` unless the site and the function are different sites. Cross-site needs `None`, which also requires the secure cookie. |
| `OURS_APP_ORIGIN` | no | Bare https origin used only as the Open Ours button. Omit it and the template has no link. No path, query, or userinfo. |

`verify_jwt` for `ours-api` must stay false. Ours does not use Supabase Auth users. A platform JWT check would reject the passkey session. Table access is still denied to the anon key by RLS.

The static build gets one public value:

| Name | Meaning |
| --- | --- |
| `VITE_API_BASE` | Function URL, for example `https://PROJECT.supabase.co/functions/v1/ours-api`. It is baked into the app and into `connect-src`. It is not a secret. |

## Tokens the coordinator holds outside the repo

Issue them against the production database with the same pepper and schema. The local commands `npm run issue-import-token` and `npm run issue-report-token` print a token once for the development database only.

- `OURS_IMPORT_TOKEN` authorizes `POST /api/import/snapshots`. A household session cannot import. The token is read from the environment, not from the command line.
- `OURS_REPORT_TOKEN` authorizes `POST /api/reports/generate`.
- The owner email address is not a setting in this app. The mailer that already runs on the coordinator keeps the recipient.

## Local development

`npm run dev` uses `OURS_ENV=development`, relying party `localhost`, and a pepper file at `.data/pepper` if `OURS_CODE_PEPPER` is unset. That file is gitignored. The database is `.data/pglite`.

## Snapshot

The normative parser is `parseSnapshotDocument` in `@ours/domain`.

`ours.snapshot` version 1 uses integer cents, an explicit `inflow` or `outflow`, and ISO timestamps that end in `Z`. `balancesAsOf` must equal the earliest balance `asOf`. Account numbers, masks, emails, and tokens are rejected and are not stored.

`finance-connector-export` version 1 is a mapping target, not a live Finance call. This environment could not read the Finance connector schema. Map the connector’s export into this envelope yourself. Set `signConvention` to `plaid` only when a positive transaction amount means money left the account. Money fields are decimal strings such as `"12.50"`, not JSON numbers. Put `providerKind` on a transaction when the source category is known. If it is omitted, the row stays unreviewed instead of being guessed. Date-only rows are counted as `dateOnlyTransactions` and are not shifted into Denver. When `postedAt` is present, `postedOn` must be that instant’s Denver civil date.

```bash
node --import tsx scripts/import-snapshot.ts --dry-run --file snapshot.json
OURS_API_BASE=https://PROJECT.supabase.co/functions/v1/ours-api \
OURS_IMPORT_TOKEN=... \
node --import tsx scripts/import-snapshot.ts --file snapshot.json
```

`--stdin` reads the same JSON from standard input. A successful import returns counts, the balance timestamp, and how many refresh requests were fulfilled. It does not print merchants.

## Report call

```http
POST /api/reports/generate
Authorization: Bearer $OURS_REPORT_TOKEN
Content-Type: application/json
X-Ours-Request: 1

{"kind":"week"}
```

`kind` is `week`, `month`, or `year`. The period is computed on the server in America/Denver. The caller does not choose the dates. Call it from the existing Monday, first-of-month, and January 1 routines. Do not send the message if `duplicate` is true unless you intentionally want the same body again. The body has category totals only.

## Refresh

The twice-daily routine should run the importer. It should not mark a refresh fulfilled by itself. Fulfillment happens inside a successful import. A duplicate fingerprint fulfills waiting requests but leaves the original balance timestamp in place.
