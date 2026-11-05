# Architecture

Ours is a static web app plus one authenticated API. The browser never queries database tables. Financial reads and writes go through the API, which checks a passkey session. The import and scheduled-report calls use separate bearer tokens that are not the session cookie.

```text
phone (static app)
  |  cookie session, no financial data in browser storage
  v
ours-api edge function  ---- service role / database URL stays on the server
  |
  v
Postgres: ours_* tables, RLS forced, no anon policies

coordinator
  |  OURS_IMPORT_TOKEN, file or stdin
  v
POST /api/import/snapshots

coordinator mail routine
  |  OURS_REPORT_TOKEN
  v
POST /api/reports/generate   (returns a template; this repo does not send mail)
```

## Money

Amounts are integer cents. A snapshot must say whether money moved in or out. The Plaid-style connector envelope is accepted only when `signConvention` is `plaid`: a positive transaction amount means money left that account. Credit and loan balances that are positive are treated as amounts owed.

Classification does not invent a category or call an unlabeled deposit income.

- A user lock is kept across imports.
- A Fix rule matches merchant or description text and can set a category.
- An equal inflow and outflow between two household accounts within four days becomes a transfer, or a debt payment when the inflow lands on a credit or loan account.
- An ambiguous pair stays unreviewed.
- Pending and unreviewed rows are left out of earnings, spending, and tithing.
- Refunds reduce category spending. They are not earnings.
- Debt payments and transfers are shown and excluded from spending, so a card purchase is not also counted when the card is paid.
- Net worth is latest balances plus custom assets and liabilities. Paying a card does not get subtracted again.

Tithing uses this Denver week’s counted earnings times the owner’s percent. The percent stays unset until someone saves one. The card then shows exactly one of: Nothing due yet, Still to pay $X, Paid, or Covered. Half-up rounding is on the exact cent. Deposits that are pending or unreviewed are listed in the detail and are not silently added.

## Time

Week, month, and year boundaries use America/Denver. A scheduled week is the last finished Monday–Sunday. A scheduled month is the previous calendar month. A scheduled year is the previous calendar year. The on-screen switcher can still show the period in progress. Those are different views.

## Bank freshness

Each completed snapshot stores the earliest account balance timestamp. The screen calls that the bank verification time. The import clock is shown separately as “Imported …”. A failed import records an error code and does not move the balance timestamp, does not fulfill a waiting refresh, and does not delete custom items, targets, rules, or locked categories. Re-importing the same fingerprint is a no-op and does not pretend the balances were newly verified. The last five completed snapshots are kept. Older snapshot rows can go away. Transactions and custom items stay.

The refresh button only inserts a pending request. The browser has no Finance connector.

## Auth

Device setup codes and recovery codes are stored as HMAC hashes. Setup codes expire. Both are single use. A setup or recovery code reserves a registration challenge. The challenge is consumed on the first finish attempt, so a replay fails. Registration and authentication are checked with `@simplewebauthn/server`: origin, relying party, user verification, and signature. A sign counter that goes backwards marks that credential unusable and revokes its sessions. Counters that stay at zero, which some platform authenticators do, are accepted because they cannot prove a clone. There is no default password and no shared key in the client.

Sessions are random tokens stored only as SHA-256 hashes. The cookie is HttpOnly. The app does not write household figures to localStorage, sessionStorage, or IndexedDB.

## Email templates

`renderEmailReport` receives category spend totals only. The HTML has an Open Ours button when `OURS_APP_ORIGIN` is a bare https origin. The text part has no URL. Generating a week, month, or year stores one row per period key. A second call returns that same template and does not write another row. Preview does not store a row. This process does not send mail and does not know the recipient.
