# Ours

Private household finance for one owner. The phone shows earnings, spending against targets you set, net worth, and this week’s tithing. It does not talk to a bank. A coordinator imports a read-only snapshot, and the screen keeps the last real balance date when a later import fails.

This repository is the source of truth for that app. It is not a live deployment. There is no Supabase project, no bank connection, and no email delivery wired up here.

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

The command prints a one-time code. It expires in 30 minutes. Stop `npm run dev` first if the local database file is already open. After the passkey is created, write down the recovery codes. They are shown once.

```bash
npm test
npm run build
```

## What is in here

- `apps/web` is a static React app.
- `packages/domain` is the money math, Denver periods, snapshot contract, and email template.
- `packages/server` is the passkey session, SQL store, and HTTP API used locally and by the edge function.
- `supabase/migrations` is the `ours_` schema with forced row-level security and no policies for anonymous access.
- `supabase/functions/ours-api` is the production entry. It is not deployed.
- `scripts/import-snapshot.ts` validates a snapshot from a file or stdin. It does not call a bank.

See `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, and `docs/DEPLOYMENT.md` for the setup that is still required.
