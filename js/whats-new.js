/**
 * What's new in RosterWarden, newest first, in plain words for the people who
 * use it. Settings shows it, and the website's What's new page carries the same
 * entries. CHANGELOG.md is the full record; this is the short version, so
 * behind-the-scenes work (servers, deploys, tests) is left out.
 *
 * Each entry: `{ date: 'YYYY-MM-DD', items: ['…'] }`.
 */
export const WHATS_NEW = [
  {
    date: '2026-11-26',
    items: [
      'Send changes: after a roster has gone out, change it and send only the people affected. Someone new gets their shifts, someone moved gets their new ones, and anyone taken off is told.',
      'After Offer to staff, let everyone know: a group message, each person\'s own message with their link, or one email each.',
      "What's new, here in Settings, lists what has changed in RosterWarden.",
    ],
  },
  {
    date: '2026-11-24',
    items: [
      "Offering more shifts to staff adds them to what's already out instead of replacing it. Building a roster on some offered dates only takes those dates off staff pages.",
    ],
  },
  {
    date: '2026-11-12',
    items: [
      "On a phone, Team's People, Shifts and Skills tabs sit just above the bottom tabs, within thumb reach.",
      "The Rosters list shows each roster's dates once, with its shift times.",
      'Building a big roster is about six times faster.',
      'Checking staff links works for teams with more than 50 people.',
      "Planning Center no longer signs you out when two things renew the sign-in at once.",
    ],
  },
  {
    date: '2026-11-11',
    items: [
      'Settings shows when your rosters were last backed up, and tells you if backups keep failing.',
      "A staff reply is no longer skipped when that person's phone has the wrong date or time.",
    ],
  },
  {
    date: '2026-11-06',
    items: [
      "Tighter security: the app only talks to the services it needs, and one misbehaving device can't use up the server for everyone.",
    ],
  },
  {
    date: '2026-11-05',
    items: [
      'Two devices on the same rosters no longer overwrite each other. If both changed, you choose which copy to keep.',
      'Next roster uses your current shifts, not the ones from when the last roster was built.',
      "One staff link sending something broken no longer stops everyone else's replies coming through.",
      "People with a max shifts limit aren't put over it, and people added with + add are kept by Rebuild around locked.",
      'Delete all data says plainly what it removes when sync is on.',
      'The app works offline straight after installing, and your AI key stays on this device only.',
    ],
  },
  {
    date: '2026-11-01',
    items: [
      'Roster and New Roster are now one Rosters tab.',
      'Build roster opens into Auto fill and Manual fill, and Send out to pick is now Offer to staff.',
      'Delete a roster with the bin beside it in the list.',
      "A shift taken off someone shows as Cancelled on their staff page instead of vanishing.",
      "Guardian's face, top right, opens Ask Guardian from anywhere, and Show me takes you to the right place.",
      'Connecting Planning Center works again.',
    ],
  },
  {
    date: '2026-10-31',
    items: [
      'Email everyone: one tap emails each person just their own shifts.',
      "Offer empty shifts on everyone's staff link: the first to tap I'll take it gets the shift.",
      'A roster covering a whole month follows on to the whole next month.',
      'In Edit, add or take off days on a calendar.',
      'Sort rosters newest or oldest first.',
      "Things to check flags anyone rostered on a day they aren't available.",
    ],
  },
  {
    date: '2026-10-30',
    items: [
      'Accounts: sign in with Google, Microsoft or email to keep your rosters safe across devices.',
      'Staff can update their own name, email and mobile from their link, and new people get a link automatically.',
      'An Updates log, and the main actions in a bar at the foot of the screen.',
      'Staff replies show up while the app is open.',
      "Staff pages show only a hint of a person's email and mobile.",
    ],
  },
  {
    date: '2026-10-29',
    items: [
      'Staff confirm or decline each of their shifts from their own link.',
      "Shifts and events: shifts can run on chosen days only, each roster day keeps its own shifts, and one-off events don't carry forward.",
    ],
  },
  {
    date: '2026-10-24',
    items: ['Shift swaps: staff can ask a colleague to take a shift, with or without your approval.'],
  },
  {
    date: '2026-10-23',
    items: ['New Roster starts with the weeks after your last roster already picked.'],
  },
  {
    date: '2026-10-22',
    items: [
      'A simpler flow: pick dates, Build, done.',
      '+ add beside any gap fills it without going into Edit.',
      'An optional step-by-step setup wizard, and rosters filled in by hand with Fill the rest for me.',
    ],
  },
  {
    date: '2026-10-20',
    items: [
      "Staff availability links: each person gets a private link to mark the dates they can't work, with no login.",
      'RosterWarden moves to rosterwarden.sixthdaystudios.com.',
    ],
  },
  {
    date: '2026-10-18',
    items: [
      'First release of the web app.',
      'Roles inside shifts, such as barista and cashier, with the hardest role filled first.',
      'Fair turns across recent rosters, Undo, and hand-made changes kept when you rebuild.',
      'Church rules: people who serve together, how often someone serves, and weeks of the month.',
      'Send rosters to Planning Center, per-person messages, hours and estimated pay.',
    ],
  },
];
