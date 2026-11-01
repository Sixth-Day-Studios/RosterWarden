# Changelog

What changed in RosterWarden, newest first. Dates are when each change reached
`main`. Entries before 31 October 2026 were written afterwards from the merged
pull requests, which are linked so the full detail is one click away.

## Unreleased

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
- The offline copy is now `rosterwarden-v3`, so every installed copy loads the
  new tabs fresh.

## 1 November 2026

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
