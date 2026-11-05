# RosterWarden sync worker

A Cloudflare Worker that stores each device's **encrypted** RosterWarden database.

It is a dumb blob store. It takes an opaque lump of bytes under an opaque id
and hands it back on request. It has no idea what a roster is, and **it cannot
read anything it holds** — the app encrypts everything on the device, and the
key never leaves it.

That is the point. Hosting other people's staff names and availability would
make you responsible for them. Hosting ciphertext you cannot decrypt does not.

One caveat: a signed-in owner's account on sixthdaystudios.com keeps their sync
code (so a new phone can sign in instead of typing it). The worker alone can't
read anything, but whoever runs both the account server and this worker could.

A device's upload (`PUT /db/:id`) carries `base`, the stamp of the copy it last
saw. If another device has saved since, the write is refused with `409` and the
stamp now stored, so two devices can't silently overwrite each other; the app
then asks which copy to keep. An upload with no `base` (an older app) still
replaces what is there.

It also keeps the **staff availability link** mailboxes (`/box/:id`, `/boxes`,
table `mailboxes` in `schema.sql`): two small encrypted boxes per staff member,
keyed by ids made from the key in their link. Same rule: it stores them and
cannot read them. Replacing a link marks its boxes `revoked`, so an old link can
never write again.

And it referees **open shifts** sent out to pick (`/claim/:id`, `/claims`, table
`claims` in `schema.sql`): the first person to take a shift holds it, and only
they can let it go. Each claim is sealed with a key only the owner and their
staff hold; the worker keeps just a hash of the claimer's secret, so it can tell
the holder apart without knowing who they are. After updating the worker, run the
`d1 execute` line under first-time setup again to add the table (it only creates
tables that are missing).

It **emails rosters out** for signed-in owners (`POST /email`, table
`email_sends` in `schema.sql`; see "Emailing rosters" below). This is the one
exception to "it cannot read anything": to send them, each person's message
reaches the worker as plain text. It passes them straight to the email service
and keeps only a count per account per day (under a hash of the account's
email). The app says so before every send.

It also does one small job for Planning Center sign-in: `POST /pco/token`,
`POST /pco/refresh` and `POST /pco/revoke` add the app's client secret (and an
identifying User-Agent, which Planning Center requires) to a token request and
pass Planning Center's answer straight back. Nothing is stored, and roster data never
comes through here (the app calls Planning Center's API directly).

## Planning Center (optional)

1. In a free Planning Center organisation of your own (you must be its
   Organization Administrator), create one OAuth app at
   <https://api.planningcenteronline.com/oauth/applications> (callback URLs: the
   site's address, and `http://localhost:8123/` for testing).
2. Put its client id in `wrangler.toml` under `[vars]` as `PCO_CLIENT_ID`, and in
   the app's `js/config.js`.
3. Store the secret on Cloudflare, never in a file:

   ```bash
   npx wrangler secret put PCO_CLIENT_SECRET
   ```

4. `npx wrangler deploy`.

Until both are set, the endpoints answer `501` and the app's Planning Center
card says it isn't set up.

## Emailing rosters (optional)

*Send → Email everyone* in the app posts each person's message here, and the
worker sends them through [Resend](https://resend.com). Each email comes from
`"<workplace> via RosterWarden" <EMAIL_FROM>`, with Reply-To set to the
workplace's business email (or the owner's account email).

Guards: the bearer token must be a signed-in owner (checked against
`ACCOUNT_URL/api/rw/me` on the account server), each account can send
`DAILY_EMAILS` (100) a day (counted before sending, in one statement, so sends
at the same moment can't add up to more; a send the email service refuses is
given back), at most 100 in one send, one address per email,
plain text only, and header fields are stripped of anything that could add a
header. The server can't read rosters, so it can't check the addresses are the
roster's people: the app picks them from the roster.

1. Sign up at Resend and verify the sending domain (the DNS records it lists).
2. Set `EMAIL_FROM` in `wrangler.toml` to an address on that domain, and check
   `ACCOUNT_URL` is the account server.
3. Store the API key on Cloudflare, never in a file:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

4. Add the `email_sends` table (only missing tables are created):

   ```bash
   npx wrangler d1 execute rosterm8 --remote --file=./schema.sql
   ```

5. `npx wrangler deploy`.

Until the key is set, `/email` answers `501` and the app shows that message.
Resend's free plan allows 100 emails a day across all accounts, so a paid plan
is needed once more than one workplace sends.

## What it costs

Nothing, at this scale, and it cannot surprise you with a bill:

| | Free allowance | What you'd use |
|---|---|---|
| Worker requests | 100,000/day | a few dozen |
| D1 storage | 5 GB | a few KB per person |
| D1 writes | 100,000/day | a few dozen |

The Cloudflare free plan has no card on file and does not overage-bill — it
stops at the limit rather than charging you. That is the main reason this sits
here rather than on AWS.

## Setting it up

You need a free Cloudflare account. No domain, no credit card.

```bash
# 1. Sign up at https://dash.cloudflare.com/sign-up   (free plan is fine)

# 2. From this folder, log in. It opens a browser once.
npx wrangler login

# 3. Create the database. This prints a database_id — copy it.
npx wrangler d1 create rosterwarden

# 4. Paste that id into wrangler.toml, replacing PASTE_YOUR_DATABASE_ID_HERE

# 5. Create the table.
npx wrangler d1 execute rosterwarden --remote --file=./schema.sql

# 6. Deploy. This prints your worker URL.
npx wrangler deploy
```

Then put the URL it printed into `js/config.js` in the app:

```js
export const SYNC_URL = 'https://rosterwarden-sync.your-name.workers.dev';
```

Commit that, and the **Sync** section appears in the app's Settings. Leave
`SYNC_URL` empty and sync simply does not exist — the app works exactly as it
does now, entirely on the device.

## Checking it works

```bash
# Should return {"error":"No data for that code"} — a 404 with valid JSON.
curl https://YOUR-WORKER-URL/db/0000000000000000000000000000000000000000000000000000000000000000
```

## How the encryption works

One secret — the sync code the user sees — produces two unrelated things:

```
secret (random, shown as the sync code)
  ├─ SHA-256("rosterwarden-id:"  + secret) ──▶ storage id   → sent to this worker
  └─ SHA-256("rosterwarden-key:" + secret) ──▶ AES-GCM key  → never sent anywhere
```

Neither can be worked back to the other, so the id this server receives tells
it nothing about the key. Data is AES-GCM encrypted with a fresh nonce per
write, which also means tampering is detected rather than silently accepted.

**Losing the sync code means losing the data.** Not recoverable by the user,
and not by you, because nobody but that device has ever held the key. The app
says so plainly next to the code. This is the unavoidable cost of the server
genuinely not being able to read what it stores.

## What the server can still see

Encryption is not invisibility. Whoever runs this can see:

- how many databases exist, and their ids
- how large each one is
- when each was last written

It cannot see names, rosters, availability, or which organisation a blob
belongs to.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | the Worker: sync, staff mailboxes, open-shift claims, roster emails, Planning Center sign-in |
| `schema.sql` | the D1 tables |
| `wrangler.toml` | deploy config; holds your `database_id` |
