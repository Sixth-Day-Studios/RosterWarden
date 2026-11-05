# RosterWarden: repo-wide audit (5 November 2026)

Audited at `ae057f8` (the same code as main after #39). Fixes are on branch **`audit-fixes`**, not yet deployed.
"Fixed" below means fixed on that branch with a regression test that fails on the old code, unless the line says otherwise.

How it was checked: every file was read (four area audits ran in parallel, each with an independent verifier trying to
refute its High/Medium findings). Suspected bugs were reproduced with throwaway scripts against the real modules and the
real worker code (stand-in database, stand-in fetch; nothing touched production). Test suite before: 219/219. After: 244/244.
The legacy Python suite still passes, 13/13. A static check confirms all 31 app modules parse and every import resolves.
**Not done:** a live browser run. The local app syncs to the production worker (`js/config.js`), so I avoided writing
test data there. Worth a manual check on two devices once deployed.

---

## System overview

- **Purpose:** fair staff rosters for small workplaces (church cafes, worship teams, catering). The owner builds rosters on their phone; staff answer through private links.
- **Types:** web app / PWA (vanilla ES modules, no build step) + Cloudflare Worker API + a retired Windows desktop app (`legacy-desktop/`, Python/Tkinter).
- **Layers:** `index.html` + `js/app.js` (boot, routing) → `js/views/*` (screens) → `js/scheduler.js` (deterministic allocation), `js/store.js` (one JSON blob in localStorage), `js/export.js` → integrations: `js/sync.js` (E2E-encrypted sync), `js/staff.js` + `js/staff-link.js` (staff mailboxes), `js/open-shifts.js`, `js/sources/planning-center.js` (OAuth + API), `js/ai.js`, `js/email.js`, `js/account.js`.
- **Worker** (`worker/src/index.js`, D1): `/db/:id` encrypted blobs, `/box/:id` staff mailboxes, `/claim/:id` open-shift claims, `/email` (Resend), `/pco/*` token swap.
- **Data flow:** every save → localStorage → debounced encrypted PUT to `/db/:id`. Staff pages write encrypted boxes, and the owner's app reads them on launch, on returning to the app and every 2 minutes, then publishes each person's page.
- **Trust boundaries:** staff pages (anyone holding a link key, untrusted JSON), Planning Center API data, AI output, URL hash/query (OAuth returns), the account server (sixthdaystudios.com), the Ask Guardian iframe (postMessage), browser storage.
- **Persistence:** localStorage (data, sync code, account token, PCO tokens in their own keys), D1 tables `blobs`, `mailboxes`, `claims`, `email_sends`.
- **Distribution:** static files to Cloudflare via `python wr.py deploy`; the worker separately via wrangler; the service worker (`sw.js`) caches the shell for offline use.
- **Destructive operations:** Delete all data, delete workplace / person / roster, rebuild / Fill the gaps, Undo, take a person off a place, replace link, adopt the account's sync code, every sync upload (whole-database replace), and staff sends (replace that person's link-sourced away dates).

## Overall health

The codebase is careful and readable, with good test habits. There are **no HTML-injection sinks anywhere**: all
rendering goes through `el()` and `textContent`. The OAuth flows (PKCE and state) are correct, there are no secrets in git
history, and SQL is parameterised. The weak spots were the **edges where two copies of the truth meet**: two devices
syncing, a staff page sending data, a roster carrying days forward, the service worker updating file by file. Several of
these lost data silently. **Overall risk before fixes: High (silent data loss across devices). After the fixes on
`audit-fixes`: Medium-Low**, with the open items below mostly hardening, ops process and low-severity bugs.

---

## Top 10 critical findings

| # | Finding | Category | Sev. | Confidence | Status |
|---|---|---|---|---|---|
| 1 | Two devices silently overwrite each other's work | Data loss | **High** | reproduced | **Fixed** |
| 2 | A detected sync "conflict" is resolved by the next save wiping the other device | Data loss | **High** | reproduced | **Fixed** |
| 3 | Next roster carries old shifts forward after any Team-tab change | Bug | **High** | reproduced | **Fixed** |
| 4 | Delete all data empties every device and the account copy, while saying "on this device" | Destructive action | **High** | reproduced | **Wording fixed; behaviour is your call** |
| 5 | One staff link sending malformed data stops staff sync for everyone after them, for good | Reliability / Security | **Med-High** | reproduced | **Fixed** |
| 6 | A module missing from the offline shell, so a fresh install's first offline launch is blank | Release | **Med-High** | reproduced | **Fixed** |
| 7 | Esc on "Which rosters do you want?" overwrites the account's sync code | Data loss | **Med-High** | reproduced | **Fixed** |
| 8 | An update can boot a mix of old and new files, leaving the app blank | Release / Reliability | Medium | simulated | **Fixed** |
| 9 | The daily email cap is bypassed by concurrent requests | Security | Medium | reproduced | **Fixed** (needs worker deploy) |
| 10 | The account server holds the sync code, so the operator could decrypt "unreadable" data | Compliance / privacy | Medium | code-confirmed | **Documented; your call** |

**1. Two devices overwrite each other.** `js/sync.js` `schedulePush` uploaded the whole database with no check of what the
server held, the worker's `PUT /db` was an unconditional upsert, and reconcile only ran at cold start.
*Scenario:* phone and iPad both open. You edit on the iPad, then the phone (still showing old data) saves anything; a staff
reply arriving is enough, since `collect` saves. The iPad's work is gone, and on its next launch it downloads the phone's
copy as an ordinary update.
*Fix:* each upload sends `base` (the stamp it last agreed with). The worker writes only if the stored copy still has that
stamp (`BLOB_SQL.writeOver`), else returns 409. The client then holds all uploads and asks **Keep this device's / Use the
other device's**. Reconcile also runs on every return to the app. Old clients without `base` keep the old behaviour, so
deploy order doesn't matter. Tests: `tests/worker-sync.test.mjs`, `tests/sync-devices.test.mjs`.

**2. Conflict "resolved" by overwriting.** On a detected conflict the app only toasted "kept what is on this one", and the
next save pushed this device's copy over the other's. *Fixed* as part of #1. A conflict now blocks uploads until the person
chooses, and dismissing the dialog asks again later.

**3. Next roster keeps stale shifts.** `carryDayShifts` carried any day whose list differed from the *current* usual
shifts, so it couldn't tell a hand edit from a later Team-tab change. Reproduced: after changing Cafe to 09:00 and adding
Lunch, every December date got the old 08:00 Cafe-only list, and so did January.
*Fix:* each new roster keeps `usualShifts` (a snapshot of the usual shifts it was built from), and only days that differ
from that snapshot carry forward (`js/scheduler.js`, `js/views/roster.js` `finish`). Rosters built before this change
can't tell the difference, so they keep the old behaviour once.

**4. Delete all data is everywhere, not "this device".** `store.reset()` saves, which triggers the sync push, so the empty
database replaces the account's copy and every other device downloads it. The confirm said "on this device". It also leaves
the sync code, account token and Planning Center tokens on the phone.
*Fixed:* the confirm now says what happens ("here, on every other device that shares these rosters, and in your account's
copy") when sync is on. **Open, your decision:** should it instead delete only this device (forget the code and tokens
without pushing)? Note it already switches off staff links for every device, so it is a global action today.

**5. Staff-link poison.** `cleanDates` accepted any `\d{4}-\d{2}-\d{2}`, so `2026-13-45` was stored, and `staffDates`'
`nextDay` then threw `RangeError: Invalid time value` on every sync and on that person's page, which is where **Clear
them** lives. Separately, any non-string where text was expected (`String({toString:1,valueOf:1})` throws) aborted
`collect` for everyone after that person, with the error swallowed as "offline". **Make a new link** couldn't recover it
either.
*Fix:* real-date validation (`isRealDate`), a `textOf` type check at each place staff data is converted, and a per-person
try/catch in `collect`, so one bad send is passed over and logged.

**6. Offline shell incomplete.** `js/views/day-shifts.js` (imported statically by roster.js and saved.js) was missing from
`SHELL` in `sw.js` from 30 Oct. Reproduced in a service-worker simulation: `OFFLINE FAIL: js/views/day-shifts.js`.
*Fixed*, plus three icons. A new test walks the import graph from `js/app.js` and fails if any module is missing.

**7. Account dialog dismissal.** `const useAccount = fresh || await dialog(...)`: Esc or Back resolves null, which fell into
"keep this device's" and called `keepCode(..., replace = true)`. *Fixed:* dismissal changes nothing and the sign-in toast
says so.

**8. Mixed-version boot.** `sw.js` posted `shell-updated` on the first changed ETag, before that file (let alone the others)
was cached, so the reload could import a new view beside an old `store.js`, and module linking fails to a blank screen.
*Fixed (minimal):* the first change triggers `refreshShell`, which `addAll`s the whole shell (all-or-nothing) before
notifying once, inside `waitUntil`. `./index.html` (redirected by Cloudflare) left the shell, and `?code=` returns are no
longer cached. *Better long-term:* stamp a build id into `CACHE` per deploy and precache atomically.

**9. Email cap race.** `emailRoster` read the count, sent through Resend, then added. Reproduced: three simultaneous sends
gave `statuses 200,200,200 | delivered 300 | daily cap 100`.
*Fixed:* one conditional statement reserves the count before sending (`EMAIL_SQL.reserve … WHERE sent + n <= cap`), and a
refused send is given back. This also removes the old "sent but not counted" path when the database write failed.

**10. Who can read the data.** `account.keepCode` sends the sync code to sixthdaystudios.com (`PUT /api/rw/key`), and the
same operator runs the worker. So "the server stores it but cannot read it" (README, worker README, help guide) is true of
the worker alone, not of the operator. *Done:* a caveat in `worker/README.md`. **Open, your decision:** reword the user-facing
privacy lines, or wrap the code client-side (e.g. with a passphrase) so the account server never holds it in usable form.

---

## Findings by area

Severity · confidence · status. File references are to `audit-fixes` unless noted.

### Architecture
- Sync was last-write-wins over whole-database blobs, with startup-only reconcile (#1, #2). **Fixed** with optimistic concurrency. *Improvement:* per-record merge would avoid asking at all, but it is a larger change.
- Client clocks decided ordering. `updatedAt` came from each device and was compared by string order across devices, so a slow clock hid edits. Medium-Low · reproduced · **Fixed** (equality against the last agreed stamp; `AGREED_CHANGE_KEY` dirty tracking).
- A startup race: a save during the startup pull was replaced by the server copy, then the stale queued upload overwrote the server. Medium · simulated · **Fixed** (change judged after the pull; queued upload cancelled on download).

### Code quality
- See *Dead / stale / duplicate* below. Comments that disagree with the code: scheduler header (3 ranking steps, really 5), `store.js` header ("no server", "Export/Import is the backup"), the sync.js comment on a visible code, the settings.js header, ui.js:76 (says a backdrop tap dismisses dialogs; nothing does), the orphaned doc comment above `roleGaps` in roster-parts.js, and the `PCO_CLIENT_ID` comment in config.js sitting above `ACCOUNT_URL`.

### Bugs / logic
- **Max shifts broken by a locked place later in the roster** (`buildRoster` counted a locked place only when the day loop reached it). Medium · reproduced (`Aaron maxShifts=1 … placed on 07 Nov, 21 Nov`) · **Fixed** (`ahead` map).
- **Rebuild with nobody active, or no shifts, dropped the locked places.** Low · reproduced · **Fixed**.
- **"+ add" in Edit wasn't locked**, so a rebuild dropped them; Undo also didn't restore `byHand`. Medium · reproduced · **Fixed**.
- **Planning Center outage signed the device out** (the worker mapped every token error to 400; the client wipes tokens on 4xx). Medium-Low · reproduced · **Fixed** (5xx/429 → 502).
- **A stray account sign-in return showed a Planning Center error** (a regression from 11a9eef). Low · reproduced · **Fixed**.
- "Offered" / "Sent" / "Last updated" dates used the UTC day (`.slice(0,10)` on an ISO stamp). Low · reproduced · **Fixed**.
- "Each person's shifts" merged two people with the same name. Low · reproduced · **Fixed**.
- A double tap on "Build from these" built two rosters. Low · replayed · **Fixed**.
- Open: a locked place whose role was removed overfills the shift with no note (Low). The Updates "Yesterday" label is wrong for an hour after DST (Low). Building on any offered date discards claims for dates not built (Low). `replaceAll` doesn't raise the id seed (Low). The people-import parser misses "Saturdays", "Mon-Fri" and dates (Low). `auditRoster` never flags over-max or never-with pairs set by hand (Low). `matchCode` never retries after a failed sign-in match (Medium-Low). A Planning Center refresh race has no single-flight; whether it signs the device out depends on PCO refusing a reused refresh token (Low-Medium, conditional). Switching team clears shift positions but not role positions (Low). The repeating-blockout fallback shifts the day in some zones (Low).

### Destructive actions / user data
- #1, #2, #4, #7 above.
- **Deleting a person or workplace left their staff links live** (the old page kept showing shifts and accepting answers nobody reads). Medium · code-confirmed · **Fixed** (`staff.retireLinks(ids)` with an offline confirm, as Delete all data does).
- **A failed save was silent** (`store.save()` returned false and no caller checked). Medium (rare) · reproduced · **Fixed** (`store.onSaveFailed` → toast).
- Open: the Replace and Swap dialogs build the new assignments when they open, so a swap handed over in the background meanwhile is reverted (Low). Undo also reverts changes made outside the roster screen (Low). Corrupt saved data is replaced by empty data on load, and a non-array collection crashes boot (Low). Re-sending to Planning Center never removes people taken off the roster (Low).

### Security
- **Confirmed and fixed:** the email cap race (#9); staff-link poison (#5). An email from a staff page with mailto extras (`sam@x.com?cc=…&body=…`) was stored and put unencoded into the owner's Email buttons: Low · reproduced · **Fixed** (strict intake regex plus encoding at both sinks). CSV formula injection (`=HYPERLINK(...)` names from Planning Center or pasted lists): Low · reproduced · **Fixed**. A Planning Center plan URL was used as a link with no scheme or host check: Low · **Fixed**. An open-shift claim name could be any object and could crash colleagues' pages: Low · reproduced · **Fixed** (string, capped at 40; impersonation within 40 characters is still possible on staff pages only, since the owner side verifies by token).
- **Hardening, partly done:** the live site sends no security headers. Added `_headers` (nosniff, Referrer-Policy, `X-Frame-Options: DENY`, `frame-ancestors 'none'`) and shipped it from `wr.py`. **Open:** a full CSP. There are no inline scripts, so a strict policy should work, but it needs testing against the live site. The suggested policy is in the ops notes below.
- **Possible risks (open):**
  - Any self-serve account can send 100 emails a day of arbitrary text from your verified domain, with a chosen display name and reply-to. Consider limiting reply-to and checking recipients.
  - The worker endpoints are unauthenticated by design and have no rate limit. Anyone can PUT 2 MB blobs under random ids, or burn the free-plan daily write and request quota, which stops sync, staff links and email for everyone until the next day. Add a Cloudflare rate-limiting rule or binding.
  - Any colleague with the open-shift key can hold every slot with a random token (staff-to-staff griefing).
  - Anyone can mint a staff-link key, write their own "staff page" and send it, getting a convincing page on your real domain whose details form posts to them. Inherent to login-free links; only remembering keys that load a real page would help.
- **Supply chain / ops (open):**
  - `wr.py` runs `npx --yes wrangler@4` (floating) with the Cloudflare token in its environment. Pin wrangler in a committed `package.json` plus lockfile, and scope the token.
  - The legacy updater (`legacy-desktop/core/updater.py`) would run any `Rosterm8.exe` from the latest release of `Mikeyau-ai/Rosterm8`, with no hash or signature check. Inert today (no releases), but keep that namespace owned to stop repojacking.
- See *Verified not an issue* for what was checked and holds up.

### API / contracts
- `PUT /db/:id` now takes an optional `base` and can answer 409 `{ updatedAt }`. Both directions are backward compatible. Documented in the worker header and `worker/README.md`.
- `/pco/token` and `/pco/refresh` now answer 502 for Planning Center 5xx/429, and still 400 for a refusal.

### Data / persistence
- The AI key was synced to every device (and wiped by a device without one), despite "stored on this device only" (Settings, README, help guide). Medium-Low · reproduced · **Fixed**: it lives in its own localStorage entry, a synced copy moves out on first read, and Delete all data forgets it.
- Open: the worker tables `mailboxes`, `claims` and `email_sends` are never cleaned up. On a shared device, Sign out keeps the sync code, so the next person's account can pick it up.

### Frontend / UI
- No XSS sinks (verified). Event listeners are cleaned up correctly.
- Open accessibility gaps (Low):
  - `openSheet` doesn't move focus in, trap it, or close on Esc.
  - `monthGrid` shows which dates are picked by CSS class only, so screen-reader users can't tell.
  - Most `label.label` elements lack `htmlFor`; the staff page's Name field has no accessible name.
  - team.js uses `role=tab` with no arrow-key handling.
  - Input borders are 1.21:1 against their background.
  - The Ask Guardian overlay doesn't trap focus, and its iframe has no `sandbox`.
- Open UX: a background re-render scrolls to the top and drops half-typed text (Low).

### Background jobs / integrations
- Staff collection (#5) is now isolated per person.
- Planning Center: pagination, 429 backoff, PKCE and revoke all verified correct. Open items: the refresh single-flight, and removals on re-send (both above).

### Operations / deployment / release
- #6 and #8 are fixed. The OAuth-return cache entries are **fixed**.
- **Open:**
  - `wr.py` deploys whatever is in the working tree: any branch, uncommitted edits, no tests. Medium-Low. Add a main/clean-tree/`node --test` gate. I didn't, because testing the gate safely means not running a deploy script.
  - There is no CI.
  - The dev server binds `0.0.0.0` and serves `.git/` and worktrees on the LAN. Low. Left alone in case you test from a phone; bind `127.0.0.1` if not.
  - The ICS file doesn't fold lines over 75 octets (Low).
- `.gitignore` now covers `.env` and `.dev.vars` (**fixed**); the duplicate `dist/` line was removed.

### Tests / quality gates
- **Added:**
  - worker `/db` conditional writes
  - Planning Center 502 vs 400
  - two-device sync (open at once, slow clock, held conflict)
  - concurrent email cap
  - malformed staff data (dates, objects, mailto email)
  - link retirement
  - max shifts with a later locked place
  - rebuild with nobody active
  - Team-tab change versus hand edit on Next roster
  - shell completeness and whole-shell refresh
  - CSV formula prefix and same-name split
  - stray sign-in return
  - save failure
  - AI key kept device-only
- **Still missing:**
  - the staff page (`js/views/staff.js`)
  - `/pco/revoke`
  - sw install/activate/offline paths
  - an end-to-end browser test

### Licensing / compliance
- No LICENSE file in a public repo (all rights reserved by default). Fine while it's free, but decide before charging (TODO.md already notes making it private).
- The privacy claim (#10).
- No vendored code, fonts or binaries; icons are generated.

### App-type specific
- **Web/PWA:** headers, the service worker, OAuth and storage are covered above.
- **Cloudflare Worker:** fixes for the cap race and concurrency. Rate limiting is open.
- **Legacy desktop:** the updater has no integrity check (Low, inert). `database.py` multi-statement writes have no rollback on a shared connection (Low). `ai_parse.py` lets a non-JSON reply raise `ValueError` uncaught, leaving the button stuck (Low). Unused `python-dateutil`, unpinned PyInstaller.

---

## Verified not an issue

- **XSS:** no `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write` or `eval` anywhere in `js/`. Every data value is rendered as text, and `href`s from data all have a fixed scheme prefix (except the PCO URL, now checked).
- **Hash routing:** `#__proto__` and `#constructor` fall through to `roster` (traced in `show()`).
- **Ask Guardian `postMessage`:** checks both `origin` and `source`; place keys are an `Object.hasOwn` allowlist.
- **OAuth:** Planning Center and account PKCE (32-byte verifier, S256), state compare, single use, and the code stripped from the URL before the swap.
- **Planning Center tokens** are kept outside synced data, and Disconnect revokes them.
- **Box revoke and write without auth:** the staff member holds the same key the owner does, so no proof could tell them apart. The only impact is a staff member breaking their own link, so this is by design.
- **CORS:** reflects any origin but sends no credentials header, and bearer tokens live in JS storage, so it isn't exploitable.
- **Email headers can't be injected:** `headerText` and `EMAIL_PATTERN` (existing tests).
- **SQL:** parameterised everywhere, worker and legacy alike.
- **Secrets:** none in `git log -p --all` (138 commits incl. gh-pages); `wr.py` never prints the token.
- **Dev server:** no path traversal (`../`, `%2e%2e`, `..%5c`, drive and UNC variants all 404).
- **Service worker:** caches only same-origin `ok`/`basic` GETs; no reload loop.
- **Dates:** all day maths uses UTC day numbers, correct across Sydney DST changes and leap years; `todayISO` is local.
- **Scheduler:** deterministic, and hardest-role-first and serves-with constraints hold.
- **Undo snapshots** never mutate in place.
- **Re-sending an unchanged roster to Planning Center** doesn't double anyone up.
- **AI keys** are sent in headers, never URLs, and unknown names from the AI are dropped.

## Dead / stale / duplicate code (not removed: outside the fixes' scope)

- **Unused:**
  - in `store.js`: `exportJSON`, `daysSinceBackup`, `backupOverdue`, `clearPastDates`, the `lastBackup` field
  - `email.isAvailable`
  - `sync.status` / `setStatus` (read by nothing)
  - `setDisabled(true)` is never called, so `OFF_KEY` and `isDisabled` are vestigial
  - `emptyState` imported in saved.js
  - in CSS: `.mono`, `.card-head`, `pre.roster-text`, `.sync-code`
  - `buildRoster`'s start/end/weekdays path (tests only)
- **Duplicates:** `export.rosterDays` vs `scheduler.rosterDates` (inlined again in `auditRoster` and `roleGaps`); `base64url` in account.js and planning-center.js.
- **Stale:**
  - `worker/README.md` setup (`rosterwarden` vs the real `rosterm8` database and a placeholder id; the `--config wrangler.toml` deploy gotcha isn't mentioned)
  - `sw.js` and dev-server comments about GitHub Pages
  - README "Settings → Name and opening hours" (now "Name, email and opening hours")
  - legacy `REPO_URL`/banners pointing at `Mikeyau-ai/Rosterm8`

## Performance

- `buildRoster` re-parses dates inside filter and sort comparators: 100 people × 90 days × 24 places took 737 ms; 300 × 365 × 40 took 9.6 s in desktop Node, with the UI frozen while it runs. Precompute day numbers and blackout sets.
- `boxBatch` and `claimBatch` run up to 200 sequential D1 reads; use `IN (…)` or `DB.batch`.
- Reconcile now runs on every return to the app: one GET plus a decrypt, which is fine at a few tens of KB.

## Refactor priorities / quick wins / test priorities

1. **Immediately:** deploy the worker (`cd worker; npx wrangler deploy --config wrangler.toml`) and the app (`python wr.py deploy`) once `audit-fixes` is merged. Either order is safe. Then try the two-device conflict on real phones.
2. **Quick wins still open:** pin wrangler plus a lockfile; gate `wr.py` on main/clean/tests; bind the dev server to 127.0.0.1; a Cloudflare rate-limit rule on the worker; a full CSP after testing; single-flight Planning Center refresh; `matchCode` retry on launch.
3. **Medium term:** atomic versioned service-worker caches per deploy; per-record sync merge; worker table cleanup; accessibility pass on sheets and calendars.
4. **Tests:** staff page, sw install/offline, an end-to-end browser run of build → edit → rebuild → Next roster.

## Decisions for you

1. **Delete all data:** keep it as "everywhere" (now stated plainly), or make it this-device-only (forget the code and tokens without pushing)?
2. **Privacy wording:** the account keeps the sync code, so "the server can't read it" holds for the worker alone. Reword the user-facing lines, or change the design?
3. **Help guide:** I edited three passages in `Y:\SixthDayStudios\site\public\rosterwarden\help.html` (two-device sync, deleting a person, Delete all data). They are not deployed or committed; that folder has other uncommitted work.
