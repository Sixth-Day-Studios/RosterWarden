# RosterWarden

**Fair staff rosters in seconds, on your phone.** From [Sixth Day Studios](https://sixthdaystudios.com),
alongside InvoiceWarden and RamWarden. Formerly **Rosterm8** (renamed 2026-10).

Add your people, set up your shifts and the roles inside them, note who's away
and who shouldn't be paired up, then press **Build roster**. RosterWarden spreads
the shifts fairly, honours every constraint you gave it, and tells you plainly
when it couldn't fill something rather than quietly fudging it. Staff can send
the dates they can't work through their own private link.

Built for a small church cafe's casual weekend roster, but nothing in it is
specific to that: it handles any set of named shifts and roles on any days of
the week, from a cafe to a worship band to a catering crew. Churches on
**Planning Center** can bring a Services team, its positions and everyone's
blockout dates straight in, and send finished rosters back into their plans.

## Using it

Open <https://rosterwarden.sixthdaystudios.com/>, tap **Add to Home Screen**
(Safari: Share → Add to Home Screen; Chrome: menu → Install app), and it behaves
like an installed app: full screen, its own icon, and it works with no signal.

Three sections (hidden on the welcome screen, until there is a workplace):

- **Rosters**: your rosters, and everything you do with one: check, edit,
  rebuild, share, rename. This is what you open it to look at. **+ New roster**
  opens the builder: the calendar and the Build button, nothing else. With no
  rosters yet, the builder is what Rosters shows.
- **Team**: People, Shifts (with their roles), and Skills, a grid of who can do
  which role.
- **Settings**, in three groups:
  - *Your workplace*: Name and opening hours, Shift swaps
  - *Connections*: Planning Center, AI assist
  - *App*: Add to Home Screen, Help and FAQ (opens the guide
    at <https://sixthdaystudios.com/rosterwarden/help>)
  - then, at the foot, the red **Delete all data** button and the account line
    (who is signed in and **Sign out**, or **Sign in** / **Sign up**)

1. **Name your workplace** on the welcome screen and pick a starting point: a
   cafe (one shift of two people), a worship team (a service with lead singer,
   backup singers, guitars, bass, drums and keys), catering or events (roles
   such as Chef and Waiter but no regular shifts) or blank. You can have more
   than one workplace; the dropdown at the top switches between them.

   Or tap **Walk me through it step by step** for the setup wizard: name and
   starting point, opening days and hours, shifts and their roles, the team (a
   pasted list), and who can do which role, then a summary before anything is
   created. Cancelling part-way keeps nothing. It is also under **Settings →
   Set up a new workplace** and **+ New organisation, step by step…** in the
   dropdown. Steps 2–4 below are what it fills in for you.
2. **People** (Team tab): everyone starts available every day; untick the days
   they can't do. **Add several** takes a pasted list of names (one per line,
   with an optional `- Sat, Sun`). Or bring a team in from Planning Center
   (below). Once the list is long there's a search box, and **Select several**
   sets days, ticks a role, or pauses people in one go.
3. **Shifts** (Team tab): the blocks of work a day is made of, e.g. `Cafe
   08:00–12:00, 2 people needed`, filled in the order listed. Each one folds to
   a line (`Lunch · Mon–Fri · 11:00–15:00 · 3 people`); tap it to change it.
   **Runs on** limits a shift to some days of the week (every day if all are
   ticked). **Copy** duplicates a shift with its roles and days. A roster keeps
   its own copy of each day's shifts when it is built, so changing a shift here
   affects the rosters you build next, not ones already made.
4. **Rosters → + New roster**: tap the dates on the calendar, press **Build
   roster** (always pinned at the foot of the screen), then **Auto fill**. It's
   saved straight away and opens under **Rosters**; there is no separate Save. The "4 people · 2 shifts · Who can do
   what" buttons open the Team screen over the calendar, so fixing set-up never
   loses your dates. The quick-pick buttons (All open days, Saturdays...) skip
   days already gone; tap a past date yourself if you really want one.

   To choose everyone yourself, press **Build roster → Manual fill** instead: the roster
   is saved empty and opens in the editor, with a "+ add" picker on every place
   listing who is free that day and can do the role. **Fill the rest for me**
   keeps everyone you placed (locked) and lets the scheduler fill the gaps fairly.

### A person's page

Besides their name and the days they can work, each person can have:

- **How often**: as often as needed, every 2nd or 3rd week at most, or about once
  a month. A preference: they're still used if nobody else is free.
- **Only these weeks of the month**: e.g. the 1st and 3rd Sunday. A date they
  asked for overrides it.
- **Roles** they can do (also on the Skills grid), **asked to work** dates, a
  **max shifts** per roster, and **away dates**.
- **Never with** (kept apart) and **Serves with** (a couple or a parent and
  child: when one is rostered, the other goes on the same shift if they're free
  and can do a place left on it).
- **Their availability link** (see Staff availability links below).
- An optional **mobile**, **email** and **pay per hour**.

### Roles inside shifts

A shift can list the roles it needs and how many of each (`Lead singer × 1,
Drums × 1`); its "Staff needed" is then their total. People are only put on roles
they're ticked for, except roles marked **anyone can do it** (serving, set-up).
The role nobody else can fill is filled first, so the only drummer isn't used
up on backing vocals. Roles belong to the workplace, so "Guitar" on the 9am and
11am services is one role and one tick per person.

### After building

A roster you just built and one from months ago open on the same screen and
can do the same things. **← Rosters**, **Edit** and **Send** are in a bar pinned
at the foot of the screen (**Edit** reads **Done** while editing, and says
"Saved": changes already save as you go). **Undo** and **Rebuild** sit under the
name, **Next roster** below the days; tap the name to rename it. To delete a
roster, tap the bin beside it in the list.

- **Things to check** (folded until opened) lists what couldn't be done.
  **Fill the gaps** turns "Drums: short on 2 days" into a picker of who else
  could do it: choosing one ticks them for the role and rebuilds.
- **+ add** sits beside every gap ("Nobody available", "needs 1 more", a role
  with nobody): tap it to choose from who is free that day and can do it. No
  need to go into Edit first; the person added is locked.
- In **Edit**, **Shifts and events** under each date changes that day's
  shifts and events: name, times, people, roles, a note (shown on the roster,
  in the group message and on staff pages), take one off (asking first if
  people are on it), or add a shift or a one-off **event**. **Same on every
  day** copies a shift's change to the roster's other days. Undo covers these.
- **Tap any name** to replace them with someone who can do the role (free that
  day first, then anyone away, marked), swap them with someone else on that day
  or any other day of the roster, take them off, or lock them in.
  A hand-made change is locked (🔒), and **Rebuild around locked** keeps it while
  refilling the rest (a rebuild leaves the roster's own old turns out of the
  fairness count). **Undo** steps back through edits, swaps and rebuilds.
- **Send**: a group message, each person's shifts, **Message each
  person** (their own dates, with Text and Email buttons when you've saved their
  mobile or email), print or PDF, a calendar file, a spreadsheet, and Planning
  Center (below).
- The tally shows shifts and hours per person, and an estimated pay total when
  anyone has a pay rate.
- **Next roster** opens the builder with the same days moved on by whole weeks,
  ready to build. Rosters re-check themselves when opened, so someone who is
  now away on a day they're rostered shows up in Things to check.
- Drafts saved by older versions still show in the list marked "Draft" and
  open in the builder; building one replaces it.

The calendar and the warnings fold away with their arrows. Requests and days
off starts folded, with what's set shown on its line ("1 asked to work · 2
can't").

### Staff availability links

A new person (added by hand, in bulk, from Planning Center or the setup
wizard) is given a link automatically, with a key checked against everyone
else's; **Create link** is only needed for people added before this. Each
person can get a private link to tell you the dates they can't work, with
no login. On their page: **Create link**, then **Email**, **Text**, **Share** or
**Copy** sends it from your own phone, and RosterWarden notes when and how it was
sent. The link opens a page with just their name, their upcoming shifts, a
calendar to tap the dates they can't work, and a note.

Beside each upcoming shift they tap **I can do it** or **Can't do it**, sent
straight away and changeable. Answers land in the roster's `responses` with the
same codes as Planning Center replies, so the roster shows ✓ or ✕ by their
name and a "can't" appears under **declined** with **Replace**. An answer is
for that person on that place, so it drops if the place goes to someone else.

A shift they said they can do that is then taken off them (taken off by hand,
the shift removed from that day, the day taken off, or the roster deleted) shows
on their page under **Cancelled** until the day has passed, so it doesn't just
vanish. A shift they swapped to someone else isn't one, and an **Undo** takes it
off the list again. The confirms for removing a shift and deleting a roster name
anyone who said they can do it.

Their page also has a **Your details** card (name, email, mobile), sent with
Save. Email and mobile replace yours straight away (a malformed email is
ignored, and a blank field changes nothing); a new name waits on their person
page as a suggestion with **Accept** and **Dismiss**, since the name is on every
roster. Only a change from what they sent last is acted on, so a repeat send
never undoes something you edited since. People from Planning Center keep the
name and email Planning Center gave them (the card says so); their mobile still
updates.

Your app picks up what they sent when it opens and whenever you come back to it
(or straight away with **Check now**). Their dates become away dates marked
"from their link", replacing what they sent before; away dates you entered are
never touched. A new date that clashes with a saved roster is announced. **Clear
them** removes only their dates, and **Make a new link** cancels the old link for
good while keeping their dates.

The key is in the link after the `#`, which browsers never send to a server.
What they enter, and the name and shifts on their page, are encrypted with it
and stored in two small mailboxes on the sync worker, which can't read them.
Your copy of each key lives in your own (encrypted) data.

### Updates from staff

Everything staff send is also written to `store.data.activity` (kept 90 days,
synced and backed up with the rest): replies to shifts, dates added or removed
(saying if one clashes with a saved roster), notes, swap asks and answers, and
changed details. The Rosters screen's **Updates** button shows the unseen count
and opens a sheet, newest first by day, with **Open roster**, **Replace** for a
"can't do" still on its roster, and **Mark all seen**. The toast that announces
new news has a **See all** link to the same sheet.

### Shift swaps

**Settings → Shift swaps** has two levels, at most one on:

- **Self swap**: a staff member asks a colleague to take one of their shifts,
  and the colleague's yes hands it over.
- **Swap with approval**: the colleague's yes then waits for you; **Approve** or
  **Decline** it in the Shift swaps box on the Rosters screen.

While either is on, every staff link page says swaps are on, each upcoming shift
has **Ask someone to take it**, and asks from colleagues show with Yes and No.
Anyone with a link can be asked, whether or not they're free that day (they may
want the extra shift), so everyone with a link sees the others' names. Staff
can't reach each other directly: asks and answers go through their own
mailboxes and your app passes them on, so a swap moves on each time your app
checks links. A swapped place is locked. An ask is cancelled if it's withdrawn,
swaps are turned off before it's answered, or you change that place on the
roster first. The Shift swaps box also lists asks still waiting for an answer.

### Opening days and hours

**Settings → Name and opening hours**:

- **Open on**: the days you normally trade. Everything else is dimmed on the
  roster calendar, and an **All open days** shortcut appears. Dimmed, not
  blocked: you can still pick a closed day for a one-off, and it shows dashed.
- **Opening hours**: fill in the times when you add a new shift.

Time fields step in 5-minute blocks, which is far quicker on a phone.

### Picking dates

The calendar takes exact dates rather than a repeating rule, because real
rosters aren't a clean pattern. The bulk buttons under each month (All open
days, Saturdays, Weekends...) keep the ordinary case quick; tap a single date to
switch it off, and tap a bulk button again to clear what it selected.

The builder starts with the weeks after your latest roster already picked
(same weekdays, moved on past any weeks already gone, leaving out one-off
days you aren't normally open), so the usual case is
just **Build roster → Auto fill**; **Clear** starts from nothing. With nothing picked the
calendar opens on this month, or next month in a month's last 10 days.

**Repeat weekly** carries the first week's pattern forward, by number of weeks
or to an end date. It's recalculated each time, so dropping 12 weeks to 4 takes
the later dates back off.

### Shifts and events

**Shifts** recur (Team tab); **events** are one-offs on a single day, such as a
wedding. Under the calendar, **Shifts and events** lists what each picked date
runs; **Change** opens the same day sheet as Edit on a built roster. Changed
shifts carry forward to the next weeks (following on, or **Next roster**);
events stay behind. With no regular shifts, Build needs at least one shift or
event on a picked date. When the days' shifts differ, the spreadsheet and text
table list one row per date and shift instead of a column per shift.

### Requests and days off

Under the calendar, **Requests and days off** lists everyone against the picked
dates: tap a date to cycle *asked to work → can't work → nothing*. With an AI
key set, you can also paste a message there ("Sarah can only do Saturdays, Tom's
away 5–9 June") and approve what it read before anything is saved.

## Planning Center

**Settings → Planning Center → Connect Planning Center** signs in with the
person's own Planning Center login (OAuth). Then:

- **Team**: pick the Services team you roster for this workplace.
- **Update from Planning Center**: adds anyone new on the team (matching
  existing people by name first, so a list typed by hand is linked, not
  duplicated) and replaces everyone's Planning Center blockouts with the current
  ones, including repeating blockouts. Away dates you typed yourself are never
  touched. The days each person can work are still set in RosterWarden.
- **Add positions from Planning Center** (on a shift): the team's positions
  become roles on that shift, each sent back as the same position, and everyone
  is ticked for the positions Planning Center has them down for.
- **Send each shift as**: the team position each shift fills (e.g. Cafe →
  Barista). A role can have its own position, which wins over its shift's.
- **Send → Planning Center → Send…**: first reads Planning Center and
  shows what would happen (how many go into how many plans, who's already there,
  who isn't on the team, shifts with no position, dates with no plan), then asks
  whether to notify. Everyone is added as **Unconfirmed**, with notifications
  *prepared but not sent*: nobody hears anything until you press Send in
  Planning Center. Sending twice doesn't double anyone up.
- **Check replies** (same place): reads who confirmed, is waiting or declined,
  marks names with ✓ or ✕, and lists anyone who declined with a **Replace**
  button. Reads only.

Each device signs in for itself; the token stays on that device and is not in
backups or sync. Sign-in uses PKCE and a `state` check, and **Disconnect**
revokes the token with Planning Center rather than just forgetting it. API calls
read Planning Center's rate-limit headers and wait out a 429. The app talks to Planning Center directly, except for the
sign-in swap, which needs the app's client secret and so goes through the sync
worker (see `worker/README.md`). With `PCO_CLIENT_ID` empty in `js/config.js`
the card just says Planning Center isn't set up.

### Setting it up (once)

1. Make a free Planning Center organisation for Sixth Day Studios (not the
   church's), as its Organization Administrator: Planning Center's own advice,
   since only org admins can create OAuth apps and every admin of that org can
   manage it. Create **one** OAuth application there at
   <https://api.planningcenteronline.com/oauth/applications>, with callback URLs
   `https://rosterwarden.sixthdaystudios.com/` and `http://localhost:8123/`.
   Every church then signs in through that one app; none of them register
   anything. The free org can also hold sample data to test against.
2. Put the client id in `js/config.js` (`PCO_CLIENT_ID`) and
   `worker/wrangler.toml` (`PCO_CLIENT_ID`).
3. From `worker/`: `npx wrangler secret put PCO_CLIENT_SECRET`, then
   `npx wrangler deploy`.

**Never put the secret (or a personal access token) in the app's own files.**
This is a public static site: anything in it can be read by anyone.

## Accounts and sync

**Sync** is on by itself when a sync server is configured: your data is
encrypted on the device with a random sync code and kept on the server, which
stores it but cannot read it. There is no code to see or type any more: a
signed-in **account** keeps the code (`js/account.js`), so a new phone gets
everything back by signing in. Until someone signs in, the code exists only on
that device, so the Rosters screen asks them to sign in.

There are no export or restore buttons; the sync code and account replace them.

## The scheduler

`js/scheduler.js` is the part that matters, and it is deliberately boring:
given the same inputs it always produces the same roster. No AI, no randomness.

For each vacancy it ranks everyone who is eligible by

1. whether they asked for that date: requests go first
2. whether they'd rather serve less often and served too recently: they go
   behind everyone else, but are still used if nobody else is left
3. fewest shifts: this roster's plus those in saved rosters from the 90 days
   before it, so fairness carries from one roster to the next
4. longest since they last worked: spread the days out
5. name: a stable tiebreak, so the result never changes between runs

and takes the top candidate. It works from the exact dates picked, and enforces
weekly and week-of-month availability, away dates, "never together" pairs, roles,
an optional per-person cap (counted within the roster), and one shift per person
per day. Requested dates override the weekday and week-of-month patterns. A
shift's roles are filled hardest first; a partner who serves with someone joins
them on the same shift when they can; locked places are kept and only the rest
is filled. Anything it can't satisfy becomes a note on the roster instead of a
silent gap.

## The AI bit is optional

**Settings → AI assist** turns pasted messages into ticked days, away dates and
clash pairs for you to approve. Names it doesn't recognise are thrown away. It
never decides who works when. Supported: Gemini, Anthropic and OpenAI; the key is
stored on this device only (fine for a personal phone, not a shared one).

## Running it locally

A static site with no build step:

```bash
python dev-server.py
```

Then open `http://localhost:8123`. `dev-server.py` sends no-cache headers so an
edit always shows, and the service worker is skipped on localhost for the same
reason. Tests:

```bash
node --test tests/*.mjs
```

## Layout

| Area | Files |
|------|-------|
| Shell + look | `index.html`, `css/app.css` (dark only, studio teal) |
| Boot + nav | `js/app.js` |
| Allocation | `js/scheduler.js` |
| Storage + backup | `js/store.js` |
| Messages, CSV, calendar, hours | `js/export.js` |
| Planning Center | `js/sources/planning-center.js` (API), `js/views/planning-center.js` (screens) |
| Staff availability links | `js/staff-link.js` (keys, mailboxes), `js/staff.js` (owner side), `js/views/staff.js` (staff page) |
| Team tab | `js/views/team.js` (People, Shifts, Skills), `js/views/people.js`, `js/views/shifts.js` |
| Setup wizard + starting templates | `js/views/wizard.js` (screens), `js/setup.js` (templates, creating the workplace) |
| AI assist | `js/ai.js` |
| Shared widgets | `js/ui.js` |
| Roster display + editing | `js/views/roster-parts.js` |
| Encrypted sync, staff mailboxes, sign-in swap | `js/sync.js`, `js/config.js`, `worker/` |
| Hosting | `wrangler.jsonc`, `wr.py` |
| Home-screen install | `js/install.js` |
| Screens | `js/views/*.js` |
| Offline | `sw.js`, `manifest.webmanifest` |
| Branding | `make_icons.py` → `icons/` |
| Tests | `tests/*.test.mjs` |

`legacy-desktop/` holds the original Windows app this replaced (still called
Rosterm8). It is no longer developed.

## Deploying

The app lives at <https://rosterwarden.sixthdaystudios.com/>, served as static
files by Cloudflare (`wrangler.jsonc`). Deploy from `main` with
`python wr.py deploy`: it copies just the app (`index.html`, the manifest,
`sw.js`, `css/`, `js/`, `icons/`) into `dist/` and publishes that, using the
Cloudflare token in Guardian's `.env`. Merging to `main` does not deploy by
itself. The old `mikeyau-ai.github.io/RosterWarden/` address is a redirect,
served from the `gh-pages` branch, that keeps any `#staff=` link part. The service
worker serves the cached copy first and refreshes in the background; when that
finds a changed file the open page reloads onto it within seconds. Add any new
file to the `SHELL` list in `sw.js` so it works offline.
