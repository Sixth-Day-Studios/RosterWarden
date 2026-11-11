# Changelog

What changed in RosterWarden, newest first. Dates are when each change reached
`main`. Entries before 31 October 2026 were written afterwards from the merged
pull requests, which are linked so the full detail is one click away.

## Unreleased

## 12 November 2026

From [#45].

- Building a big roster is about six times faster (100 people over 90 days
  went from about 0.9 seconds to 0.15), so the screen no longer hangs while
  it works.
- Checking staff links now works for workplaces with more than 50 people
  with a link. The sync server read each person's mailbox as its own
  database query, and the free plan allows a request only 50; they are now
  read together as one. Needs a worker deploy.
- Planning Center no longer signs a device out when two requests renew the
  sign-in at the same moment. They now share one renewal.
- Each encrypted copy (your synced rosters, each staff mailbox, each claim on
  an open shift) is now sealed for the exact place it is stored, so whoever
  runs the server can't hand one back in place of another, such as a claim
  moved onto a shift the person never took. Nothing looks different. Copies
  made before this still open until a sealed one has replaced them.
- Taking in what staff sent saves once for the whole lot instead of once per
  change, which is quicker on a phone with a big team.
- The sync server tidies up after itself once a day: claims on open shifts
  older than six months and old daily email counts are removed. Your synced
  rosters and staff mailboxes are never removed. Needs a worker deploy.
- The tests now run by themselves on GitHub for every pull request.
- `python wr.py worker-deploy` publishes the sync worker behind the same
  checks as the app (clean `main`, tests passing), always with the worker's
  own config. The checks also accept a checkout sitting at `main`'s latest
  commit, for a second working folder that can't switch to `main`.
- The local development server can only be reached from this computer,
  unless started with `--lan` to try the app on a phone.

## 11 November 2026

From [#44].

- Settings now says when your rosters were last backed up, just above
  **Delete all data**. If the sync server keeps refusing a backup (for
  example, the rosters have grown too big), the app tells you once and
  Settings says why, instead of failing without a word. Being offline is
  still quiet, as before.
- A reply from a staff link is no longer skipped when that person's phone
  has the wrong date or time. Before, one send from a phone running fast
  could hide everything they sent afterwards.
- Opening the app without setting up a workplace no longer leaves an empty
  copy on the sync server. The first copy is made once there is a workplace
  to keep.
- The sync server holds every part of what it stores to a sensible size, not
  only the main part, and refuses an oversized request before reading it.
  The biggest backup it accepts is now just under the database's own limit
  (about 1.9 MB), so one that is accepted can always be stored. Needs a
  worker deploy.
- When something goes wrong inside the sync server, the app is now told so
  instead of being left to think the phone is offline, so a server fault
  counts toward the "not being backed up" warning above. Needs a worker
  deploy.
- The deploy tool (wrangler) is updated from 4.151.3 to 4.160.0, which clears
  three security advisories in its own dependencies. Nothing in the app
  itself used them. Run `npm ci` again before the next deploy.

## 6 November 2026

From [#42] and [#43].

- Cloudflare's visit counter works again on the app. The new security policy
  had blocked it; it counts page visits without cookies, as the privacy
  page says.
- The site now tells browsers exactly what it may load and talk to (a
  Content Security Policy): only its own code and styles, the sync server,
  Planning Center, your account, Ask Guardian and the AI providers. Code that
  somehow got into the page couldn't send your rosters anywhere else.
- The sync server now limits how many requests one connection can make a
  minute, so one misbehaving client can't use up the day's free allowance
  and stop sync, staff links and emails for everyone. Normal use is far
  below the limit. If it is ever reached, the app asks you to try again in
  a minute, and Planning Center stays connected.
- Deploying (`python wr.py deploy`) only goes ahead from a clean `main` whose
  tests pass (`--force` overrides), and uses the exact wrangler version in
  `package-lock.json` (run `npm ci` once) instead of whatever npm offers that day.

## 5 November 2026

From [#40], a repo-wide audit (`AUDIT.md`), and [#41].

- A new phone could open on "Changed on two devices" the first time it
  synced, with no other device involved: the launch and the app coming back on
  screen each synced at the same moment and took each other for a clash. A
  device's syncs now run one at a time, and an upload left waiting while the
  other device's copy comes in is dropped instead of sent over it.

- Two devices on the same rosters no longer overwrite each other. If both
  changed things since they last matched (both open at once, or one offline),
  RosterWarden asks which copy to keep, **Keep this device's** or **Use the
  other device's**, and uploads nothing until you choose. Before, the last to
  save silently replaced the other's work. Coming back to the app now picks up
  the other device's changes straight away, and a phone whose clock is wrong
  can't make a newer copy look older.
- **Next roster** and the builder's follow-on weeks use your current shifts. A
  shift changed on the Team tab after a roster was built kept coming back on
  every roster after it; now only days you changed by hand carry forward.
- A staff link that sent something malformed (a date like 13/45, or the wrong
  kind of data) stopped dates, replies and swaps arriving from everyone after
  that person, and broke their page in the app. It is now ignored, and
  everyone else's still comes through.
- An email sent from a staff link's Your details with extra parts in it (such
  as `?bcc=`) is refused, and the Email buttons can't be given hidden
  recipients.
- Someone with a max shifts limit is no longer put over it when they have a
  locked place later in the roster, and a rebuild with nobody active keeps the
  locked places instead of emptying the roster.
- People added with **+ add** in Edit are locked, as other hand-made changes
  are, so **Rebuild around locked** keeps them, and Undo restores a hand-filled
  roster properly.
- Deleting a person or a workplace switches off their staff links, as Delete
  all data already did, so an old page stops showing their shifts.
- **Delete all data** now says plainly that, with sync on, it empties every
  device sharing these rosters and your account's copy, not just this one.
- Dismissing "Which rosters do you want?" after signing in no longer replaces
  the rosters your account keeps; it changes nothing.
- The AI key really is kept on this device only. It was being synced to your
  other devices; it is now taken out of the synced copy, and Delete all data
  forgets it.
- If this device can't save (its storage is full or blocked), it says so
  instead of losing the changes silently when the app closes.
- The app works offline on its first launch after installing: one of its files
  was missing from the offline copy. An update now fetches all of its files
  before reloading, so it can't start with a mix of old and new ones.
- Planning Center being down or busy no longer signs you out of it, and a
  stray return from the account sign-in no longer shows a Planning Center
  error.
- The daily limit of 100 roster emails can't be got around by sending several
  at once.
- Spreadsheet exports can't run a name as a formula, two people with the same
  name stay apart in "Each person's shifts", "Build from these" can't build
  twice from a double tap, and dates shown as "Offered" or "Sent" use your
  own time zone.
- The site now tells browsers never to show it inside another site's frame.
- The privacy notes now say plainly who can unlock your rosters: the sync
  server only ever stores a locked copy, but your account keeps the key so a
  new phone can sign in, which means Sixth Day Studios could unlock them
  (it never does). Deleting your account removes the key; signing out doesn't.

## 1 November 2026

From [#37], [#38] and [#39].

- Connecting Planning Center works again. Coming back from its sign-in
  showed "That sign-in wasn't started on this device" and connected nothing,
  because the RosterWarden account sign-in took the return as its own.
- **Roster** and **New Roster** are now one **Rosters** tab. **+ New roster**
  at the top of the list opens the builder, and **← Rosters** goes back. With
  no rosters yet, Rosters opens straight on the builder.
- The tabs are hidden on the welcome screen, which every tab used to show
  again. *Settings and help* at its foot still opens Settings.
- In the builder, **Build roster** opens out into **Auto fill** (the scheduler,
  as before) and **Manual fill** (what *Fill in by hand* was). *Send out to
  pick* is now **Offer to staff**.
- Delete a roster with the bin beside it in the Rosters list. The **Delete**
  inside an opened roster has gone, leaving **Next roster** there.
- A shift someone said they can do that is then taken off them (or its day or
  roster removed) now shows under **Cancelled** on their staff link page until
  the day passes, instead of just vanishing. The confirms for deleting a roster
  and removing a shift from a day name anyone who said they can do it.
- **Next one** is now **Next roster**. It, opening a draft, and choosing a
  roster under **Updates** work again. They had stopped doing anything since
  the Settings tidy-up.
- Guardian's face at the top right of the screen opens **Ask Guardian**, so
  help is one tap from anywhere (it's still in Settings too). Her guide now
  matches the new Rosters tab, and she can answer how-to questions in a few
  numbered steps instead of squeezing them into four sentences.
- Guardian knows which screen you're on. When an answer is about a place in
  the app, **Show me** under it closes the chat, takes you there and makes the
  right heading or button glow. Her panel has one title and close button now,
  not two.
- The offline copy is now `rosterwarden-v3`, so every installed copy loads the
  new tabs fresh.
- Settings has an *Ask Guardian* button above *Help and FAQ*. It opens the
  Sixth Day Studios help chat over the app, already knowing you're in
  RosterWarden. Close it with the cross or Esc.

## 31 October 2026

All in [#35].

- A roster covering a whole month now follows on to the same days across the
  whole next month. Before, it moved on five weeks, so the next one started a
  few days late and ran into the month after.
- *Things to check* flags anyone rostered on a day they aren't available (put
  on by hand, kept by a lock, or their days changed since), not only people who
  are away.
- In **Edit**, *Days on this roster* is a calendar of the roster's dates: tap
  one to add it or take it off. **Undo** brings a day back.
- The list of rosters sorts **Newest first** or **Oldest first**.
- "Usually off" in the hand-edit pickers now respects weeks of the month, not
  just the weekday.
- **Send out to pick:** on New Roster, the picked dates' empty shifts go out on
  everyone's staff link. The first to tap *I'll take it* gets a shift, and
  *Can't do this day* becomes an away date. You see who took what and who
  hasn't answered, and *Build from these* locks the taken shifts in.
- **Email everyone:** under Send, one tap emails each person on a roster just
  their own shifts, after a screen listing who gets one and who's skipped.
  Emails come from "*your workplace* via RosterWarden", and replies go to the
  business email set in Settings.
- Removed old code nothing used any more (the plain-text table and leftover
  sync-code helpers).

## 30 October 2026

- **Close this page** on a staff page also makes the device forget it, so the
  app icon opens the ordinary app again ([#34]).
- Staff who also run rosters of their own can get from the staff page to their
  own rosters ([#33]).
- Settings drops the sync code and backup screens, now that an account keeps
  the code. **Delete all data** and **Sign out** sit at the foot ([#32]).
- Staff pages show only a hint of the person's email and mobile, so a
  forwarded link doesn't give them away ([#31]).
- Staff replies show up while the app is open. **Delete all data** switches
  off old staff links ([#30]).
- The app bar shows who is signed in. **Delete all data** forgets a remembered
  staff link ([#29]).
- Signing in goes straight to the site and back, with no code to copy and no
  Approve step ([#24], [#28]). The welcome screen says who is signed in ([#27]).
- Fixes for the app reopening on a remembered staff link, and a **Close this
  page** exit on staff pages ([#25], [#26]).
- **Accounts:** sign in with Google, Microsoft or email to keep your rosters
  safe across devices. Simpler person screen and setup wizard, and slide
  transitions ([#23]).
- Staff can edit their own name, email and mobile from their link. New people
  get a staff link automatically. An **Updates** log, and the main actions in a
  bar at the foot of the screen ([#22]).

## 29 October 2026

- Staff confirm or decline each of their shifts from their own link ([#21]).
- **Shifts and events:** a roster keeps its own shifts for each day. Shifts
  can run on chosen days only. A built roster's shifts can be changed day by
  day, and each day's shifts can be planned before building. One-offs are
  called events and don't carry forward. A catering starting point
  ([#16], [#17], [#18], [#19], [#20]).
- A sync code can be entered from the welcome screen, even with sync already
  on ([#15]).

## 24 October 2026

- **Shift swaps:** staff can ask a colleague to take a shift, with or without
  the owner's approval, and the owner can swap people across any day ([#14]).

## 23 October 2026

- New Roster starts with the weeks after your last roster already picked
  ([#13]).

## 22 October 2026

- **+ add** beside any gap on a roster fills it without going into Edit
  ([#12]).
- A simpler flow: pick dates, **Build**, done. The built roster is saved and
  opens on the Roster screen ([#11]).
- An optional step-by-step setup wizard, and rosters filled in by hand with
  **Fill the rest for me** ([#10]).

## 20 October 2026

- The app is hosted at <https://rosterwarden.sixthdaystudios.com/> ([#8]).
- **Staff availability links:** each person gets a private link to mark the
  dates they can't work, with no login ([#7]).
- README brought up to date ([#9]).

## 18 October 2026

First release of the web app, rebuilt from the Rosterm8 desktop app (see
`legacy-desktop/CHANGELOG.md` for its history).

- **Roles inside shifts**, such as barista and cashier, or lead singer and
  drums. People tick the roles they can do, and the hardest role is filled
  first ([#1]).
- The **Team** tab (People, Shifts, Skills), set-up sheets, and a quicker
  roster builder ([#2]).
- New people are available every day until marked otherwise ([#3]).
- Sections fold away, tap a name to replace or swap them, and rosters can be
  sent to Planning Center with a preview ([#4]).
- Fairness counts turns across recent rosters. Hand-made changes are locked,
  there is **Undo**, and Planning Center replies come back ([#5]).
- Church rules: people who serve together, how often someone serves, and
  weeks of the month. Per-person messages, hours and estimated pay, people
  search and bulk edit ([#6]).

[#1]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/1
[#2]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/2
[#3]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/3
[#4]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/4
[#5]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/5
[#6]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/6
[#7]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/7
[#8]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/8
[#9]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/9
[#10]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/10
[#11]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/11
[#12]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/12
[#13]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/13
[#14]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/14
[#15]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/15
[#16]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/16
[#17]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/17
[#18]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/18
[#19]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/19
[#20]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/20
[#21]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/21
[#22]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/22
[#23]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/23
[#24]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/24
[#25]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/25
[#26]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/26
[#27]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/27
[#28]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/28
[#29]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/29
[#30]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/30
[#31]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/31
[#32]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/32
[#33]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/33
[#34]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/34
[#35]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/35
[#37]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/37
[#38]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/38
[#39]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/39
[#40]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/40
[#41]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/41
[#42]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/42
[#43]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/43
[#44]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/44
[#45]: https://github.com/Sixth-Day-Studios/RosterWarden/pull/45
