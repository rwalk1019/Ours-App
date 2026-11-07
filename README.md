# Ours

Private household finance for one owner. The phone shows earnings, spending against targets you set, net worth, and this week’s tithing. It does not talk to a bank. A coordinator imports a read-only snapshot, and the screen keeps the last real balance date when a later import fails.

The household Supabase project already exists. This repo does not replace its tables, its `ours-auth` function, or its snapshot upload. See `docs/LIVE_BACKEND.md`.

## Run it locally

```bash
npm install
npm run dev
```

- App: http://localhost:41773
- API: http://127.0.0.1:41774

Passkeys on this machine only work when the page is opened as `localhost`, because that is the relying party. The sample household does not need a passkey: on the locked screen choose **Preview sample household**. Those figures are fictional and are not saved.

A signed-in household starts empty. Nothing invents a tithing percent or a spending target. To register a device:

```bash
npm run setup-code
```

The command prints a one-time code for the local fixture and expires in 24 hours. Stop `npm run dev` first if `.data/live` is already open. Backup codes are created only from the signed-in screen, after you confirm that the old ones should stop working.

```bash
npm test
npm run build
```

## What is in here

- `apps/web` is a static React app.
- `packages/domain` is the money math, Denver periods, snapshot contract, and email template.
- `packages/server/src/live` is a local fixture of the existing tables and RPCs. It does not drop a database that already has them.
- `supabase/greenfield/0001_ours.sql` is an older draft. It aborts if the live tables exist and is not in `supabase/migrations`.
- `supabase/additive/ours_settings_presence.sql` adds one function and does not change rows.
- `scripts/prepare-live-upload.ts` checks that a snapshot has accounts and does not post it.

See `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, and `docs/DEPLOYMENT.md` for the setup that is still required.
