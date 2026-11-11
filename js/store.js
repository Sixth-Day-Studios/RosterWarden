/**
 * On-device storage for RosterWarden.
 *
 * Everything lives in one JSON blob in localStorage. There is no server and no
 * account: the roster never leaves the device it was made on. A roster for a
 * dozen people over a few months is a few kilobytes, so a single blob is both
 * simpler and more robust than IndexedDB here - and it makes Export/Import a
 * one-liner, which is the real backup story.
 *
 * The data is organised in two layers: an **organisation** owns everything, and
 * people, shifts, clash rules and saved rosters all belong to exactly one
 * organisation. Switching organisation swaps the entire working set.
 */

const KEY = 'rosterwarden.v1';

/**
 * Current shape of the saved data.
 *
 * Bump this and add a step to `MIGRATIONS` whenever the stored shape changes.
 * Data already on someone's phone is upgraded in place on load - there is no
 * server to run a migration on, so it has to happen the moment the app opens,
 * and it has to be safe to run on data written by any older version.
 */
const SCHEMA_VERSION = 3;

/**
 * Upgrade steps, keyed by the version they upgrade *to*.
 * Each takes the whole data object and mutates it in place.
 */
const MIGRATIONS = {
  // v2: people gained a `requests` list (dates they asked to work), and
  // organisations gained opening days/hours.
  2(data) {
    for (const person of data.people || []) {
      if (!Array.isArray(person.requests)) person.requests = [];
    }
    for (const org of data.orgs || []) {
      if (!Array.isArray(org.openDays)) org.openDays = [0, 1, 2, 3, 4, 5, 6];
      if (typeof org.openTime !== 'string') org.openTime = '';
      if (typeof org.closeTime !== 'string') org.closeTime = '';
    }
  },

  // v3: roles inside shifts. Roles are defined once per organisation
  // (`data.roles`), a shift lists the roles it needs and how many of each
  // (`shift.roles`), and a person lists the roles they can do (`person.roleIds`).
  // Nothing changes for an existing shift: with no roles it is still just
  // "this many people".
  3(data) {
    if (!Array.isArray(data.roles)) data.roles = [];
    for (const shift of data.shifts || []) {
      if (!Array.isArray(shift.roles)) shift.roles = [];
    }
    for (const person of data.people || []) {
      if (!Array.isArray(person.roleIds)) person.roleIds = [];
    }
  },
};

/**
 * Bring `data` up to the current schema, running each step it has not had yet.
 *
 * Returns true if anything changed, so the caller can write the upgraded data
 * straight back - otherwise the same migration would run on every single load.
 */
function migrate(data) {
  const from = Number(data.version) || 1;
  if (from >= SCHEMA_VERSION) return false;

  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    MIGRATIONS[v]?.(data);
  }
  data.version = SCHEMA_VERSION;
  return true;
}

/** Shape of a brand-new, empty database. */
function emptyData() {
  return {
    version: SCHEMA_VERSION,
    orgs: [],
    currentOrgId: null,
    shifts: [],
    roles: [],
    people: [],
    clashes: [],
    rosters: [],
    // Shift swaps staff asked for through their links (see js/staff.js).
    swaps: [],
    // What staff sent through their links, for the owner to review (see js/staff.js).
    activity: [],
    // Shifts sent out for staff to take before building (see js/open-shifts.js).
    openShifts: [],
    settings: { aiProvider: 'gemini', aiModel: '' },
  };
}

/**
 * Settings kept on this device only, in their own localStorage entries and
 * never in the synced data: an AI key is a secret for this phone ("stored on
 * this device only", Settings says), and syncing it would put it on every
 * device that shares these rosters.
 */
const DEVICE_SETTINGS = { aiKey: 'rosterwarden.ai.key' };

/** Monotonic-ish id generator; unique within this device, which is all we need. */
let idSeed = Date.now();
function newId() {
  idSeed += 1;
  return idSeed;
}

export const store = {
  data: emptyData(),

  /**
   * Load from localStorage, tolerating absent, corrupt or older data.
   * A parse failure must never leave the user staring at a broken app, so we
   * fall back to empty rather than throwing.
   */
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        // Nothing stored: reset rather than leaving whatever happened to be in
        // memory. Without this, loading after a wipe silently keeps the old
        // data and the next save writes it straight back.
        this.data = emptyData();
      } else {
        const parsed = JSON.parse(raw);
        this.data = { ...emptyData(), ...parsed };
        this.data.settings = { ...emptyData().settings, ...(parsed.settings || {}) };

        // Take the version from the file, never from the defaults merged in
        // above. The earliest databases have no `version` at all, and spreading
        // them over a default of "current" would make them look already
        // migrated - so the upgrade would silently never run.
        this.data.version = Number(parsed.version) || 1;

        // Upgrade anything written by an older version, then write it straight
        // back so the work is done once rather than on every load.
        if (migrate(this.data)) {
          this.save();
          console.info('[store] upgraded saved data to v%d', SCHEMA_VERSION);
        }
      }
    } catch (err) {
      console.warn('Could not read saved data; starting fresh.', err);
      this.data = emptyData();
    }
    // Keep ids climbing above anything already stored, so a reload cannot
    // reissue an id that is still in use.
    const all = [...this.data.orgs, ...this.data.people, ...this.data.shifts, ...this.data.roles, ...this.data.rosters];
    for (const item of all) if (item?.id >= idSeed) idSeed = item.id + 1;
    return this.data;
  },

  /**
   * Persist to localStorage. Returns false if the write failed (private mode,
   * quota, storage disabled) so the caller can warn instead of losing data
   * silently.
   */
  save() {
    // Inside `batch`: noted, and written once when the batch ends.
    if (this._batching) {
      this._unsaved = true;
      return true;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (err) {
      console.error('Could not save.', err);
      // Nothing else checks for this, so whoever listens (the app) tells the person: the change is only in
      // memory and will be gone when the app closes.
      try { this._onSaveFailed?.(err); } catch { /* the warning itself failed; nothing more to do */ }
      return false;
    }
    // Tell whoever is listening (the sync layer) that the data moved on. Kept
    // as a plain callback so the store stays ignorant of what sync even is.
    try {
      this._onSaved?.(this.data);
    } catch (err) {
      console.warn('A save listener threw; the save itself was fine.', err);
    }
    return true;
  },

  /**
   * Run `fn`, which makes many changes in one go, saving once when it ends instead of after each change.
   * Every save writes the whole database, so taking in what thirty staff sent was thirty or more full
   * writes. `fn` must not wait on anything (no await): a save held back across a network call could be
   * lost if the app closed meanwhile. Returns what `fn` returns.
   */
  batch(fn) {
    if (this._batching) return fn();   // already inside one: its end saves
    this._batching = true;
    try {
      return fn();
    } finally {
      this._batching = false;
      if (this._unsaved) {
        this._unsaved = false;
        this.save();
      }
    }
  },

  /** Register a single listener called after every successful save. */
  onSaved(fn) {
    this._onSaved = fn;
  },

  /** Register a single listener called when a save could not be written (storage full or blocked). */
  onSaveFailed(fn) {
    this._onSaveFailed = fn;
  },

  /**
   * Adopt a whole database wholesale, e.g. the server's copy at startup.
   *
   * Writes without going through the save listener, because this data came
   * *from* the server - re-uploading it would be a pointless round trip and
   * would move the timestamp for no reason.
   */
  replaceAll(data) {
    this.data = { ...emptyData(), ...data };
    this.data.settings = { ...emptyData().settings, ...(data.settings || {}) };
    this.data.version = Number(data.version) || 1;
    migrate(this.data);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (err) {
      console.error('Could not save the copy from the server.', err);
      return false;
    }
    return true;
  },

  // ---------------------------------------------------------- organisations --
  /** Every organisation, alphabetically. */
  orgs() {
    return [...this.data.orgs].sort((a, b) => a.name.localeCompare(b.name));
  },

  /** The organisation currently being worked on, or null if there are none. */
  currentOrg() {
    return this.data.orgs.find((o) => o.id === this.data.currentOrgId) || null;
  },

  /** Switch the working organisation. */
  setCurrentOrg(id) {
    this.data.currentOrgId = id;
    this.save();
  },

  /** Create an organisation, select it, and return it. */
  addOrg(name) {
    const org = {
      id: newId(),
      name: name.trim(),
      // Open every day until told otherwise, so nothing is greyed out on the
      // calendar before the user has actually said when they're open.
      openDays: [0, 1, 2, 3, 4, 5, 6],
      openTime: '',
      closeTime: '',
      // Where staff replies to roster emails go (js/email.js); empty means the owner's account email.
      replyEmail: '',
    };
    this.data.orgs.push(org);
    this.data.currentOrgId = org.id;
    this.save();
    return org;
  },

  /** Apply a patch to one organisation (opening days, hours, name, business email for replies). */
  updateOrg(id, patch) {
    const org = this.data.orgs.find((o) => o.id === id);
    if (org) Object.assign(org, patch);
    this.save();
  },

  /**
   * The weekdays the current organisation is open, as an array of 0-6.
   *
   * Organisations created before opening days existed have no such field, and
   * a restored backup may not either - treat those as open every day, which is
   * the same as "not configured" and greys nothing out.
   */
  openDays() {
    const org = this.currentOrg();
    return Array.isArray(org?.openDays) ? org.openDays : [0, 1, 2, 3, 4, 5, 6];
  },

  /** Rename an organisation in place. */
  renameOrg(id, name) {
    const org = this.data.orgs.find((o) => o.id === id);
    if (org) org.name = name.trim();
    this.save();
  },

  /** Delete an organisation and everything inside it. */
  deleteOrg(id) {
    this.data.orgs = this.data.orgs.filter((o) => o.id !== id);
    this.data.people = this.data.people.filter((p) => p.orgId !== id);
    this.data.shifts = this.data.shifts.filter((s) => s.orgId !== id);
    this.data.roles = this.data.roles.filter((r) => r.orgId !== id);
    this.data.clashes = this.data.clashes.filter((c) => c.orgId !== id);
    this.data.rosters = this.data.rosters.filter((r) => r.orgId !== id);
    this.data.swaps = this.data.swaps.filter((w) => w.orgId !== id);
    this.data.activity = this.data.activity.filter((a) => a.orgId !== id);
    this.data.openShifts = this.data.openShifts.filter((o) => o.orgId !== id);
    if (this.data.currentOrgId === id) {
      this.data.currentOrgId = this.data.orgs[0]?.id ?? null;
    }
    this.save();
  },

  // ----------------------------------------------------------------- shifts --
  /** The current organisation's shifts, in the order the scheduler fills them. */
  shifts() {
    const org = this.data.currentOrgId;
    return this.data.shifts
      .filter((s) => s.orgId === org)
      .sort((a, b) => a.order - b.order || a.id - b.id);
  },

  /** A fresh unique id, for a one-off shift that lives only on a roster's day. */
  newShiftId() {
    return newId();
  },

  /** Add a shift to the current organisation and return it. */
  addShift({ name = 'Day', start = '', end = '', headcount = 1 } = {}) {
    const shift = {
      id: newId(), orgId: this.data.currentOrgId,
      name, start, end, headcount,
      roles: [],
      order: this.shifts().length,
    };
    this.data.shifts.push(shift);
    this.save();
    return shift;
  },

  /**
   * A copy of a shift, roles and all, placed just after the original: the
   * 11am service starts out as the 9am one.
   */
  duplicateShift(id) {
    const from = this.data.shifts.find((s) => s.id === id);
    if (!from) return null;
    const copy = this.addShift({
      name: `${from.name} (copy)`, start: from.start, end: from.end, headcount: from.headcount,
    });
    copy.roles = (from.roles || []).map((r) => ({ ...r }));
    if (Array.isArray(from.days)) copy.days = [...from.days];
    copy.pcoPosition = from.pcoPosition ?? null;
    // Slot it in right after the original, keeping the order numbers whole.
    const ordered = this.shifts().filter((s) => s.id !== copy.id);
    ordered.splice(ordered.findIndex((s) => s.id === id) + 1, 0, copy);
    ordered.forEach((s, i) => { s.order = i; });
    this.save();
    return copy;
  },

  /** Apply a patch to one shift. */
  updateShift(id, patch) {
    const shift = this.data.shifts.find((s) => s.id === id);
    if (shift) Object.assign(shift, patch);
    this.save();
  },

  /** Remove a shift. */
  deleteShift(id) {
    this.data.shifts = this.data.shifts.filter((s) => s.id !== id);
    this.shifts().forEach((s, i) => { s.order = i; });   // close the gap
    this.save();
  },

  /** Swap a shift with its neighbour, changing the fill order. */
  moveShift(id, delta) {
    const list = this.shifts();
    const i = list.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i].order, list[j].order] = [list[j].order, list[i].order];
    this.save();
  },

  // ------------------------------------------------------------------ roles --
  /**
   * The current organisation's roles, in the order they were made.
   *
   * A role is a job inside a shift: "Drums", "Making coffee". It belongs to
   * the organisation, not to one shift, so "Guitar" on the 9am and 11am
   * services is one role, and one tick on a person's page says they can play it.
   */
  roles() {
    const org = this.data.currentOrgId;
    return this.data.roles
      .filter((r) => r.orgId === org)
      .sort((a, b) => a.order - b.order || a.id - b.id);
  },

  /**
   * The role with this name (any capitals), made if it doesn't exist yet.
   * Returns null for a blank name.
   */
  addRole(name) {
    const clean = String(name ?? '').trim();
    if (!clean) return null;
    const existing = this.roles().find((r) => r.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const role = {
      id: newId(), orgId: this.data.currentOrgId, name: clean,
      // false: only people ticked for the role are put on it. true: anyone
      // can do it (serving at a cafe), so nobody needs ticking one by one.
      anyone: false,
      // The Planning Center position this role is sent as, if mapped.
      pcoPosition: null,
      order: this.roles().length,
    };
    this.data.roles.push(role);
    this.save();
    return role;
  },

  /**
   * Apply a patch to one role. A rename to a name another role already has is
   * refused (returns false) - two roles with one name could not be told apart.
   */
  updateRole(id, patch) {
    const role = this.data.roles.find((r) => r.id === id);
    if (!role) return false;
    if (typeof patch.name === 'string') {
      const clean = patch.name.trim();
      const clash = this.roles().some((r) => r.id !== id && r.name.toLowerCase() === clean.toLowerCase());
      if (!clean || clash) return false;
      patch = { ...patch, name: clean };
    }
    Object.assign(role, patch);
    this.save();
    return true;
  },

  /**
   * Delete a role: it comes off every shift and every person. Assignments in
   * saved rosters keep it, so an old roster still reads "Drums: Sam" - it just
   * shows as a removed role.
   */
  deleteRole(id) {
    this.data.roles = this.data.roles.filter((r) => r.id !== id);
    this.roles().forEach((r, i) => { r.order = i; });   // close the gap
    for (const shift of this.data.shifts) {
      if (shift.roles?.some((r) => r.roleId === id)) {
        shift.roles = shift.roles.filter((r) => r.roleId !== id);
      }
    }
    for (const person of this.data.people) {
      if (person.roleIds?.includes(id)) person.roleIds = person.roleIds.filter((r) => r !== id);
    }
    this.save();
  },

  /**
   * Put `count` of a role on a shift (or change the number already there).
   * Zero removes it. While a shift has roles its headcount is simply their
   * total, so everything that only cares how many people it needs still works.
   */
  setShiftRole(shiftId, roleId, count) {
    const shift = this.data.shifts.find((s) => s.id === shiftId);
    if (!shift) return;
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const rest = (shift.roles || []).filter((r) => r.roleId !== roleId);
    const had = (shift.roles || []).findIndex((r) => r.roleId === roleId);
    if (n > 0) {
      // Keep a role where it was when its number changes; a new one goes last.
      if (had >= 0) rest.splice(had, 0, { roleId, count: n });
      else rest.push({ roleId, count: n });
    }
    shift.roles = rest;
    if (rest.length) shift.headcount = rest.reduce((sum, r) => sum + r.count, 0);
    this.save();
  },

  // ----------------------------------------------------------------- people --
  /** The current organisation's people, alphabetically. */
  people() {
    return this.data.people
      .filter((p) => p.orgId === this.data.currentOrgId)
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Add a person, and return them.
   *
   * A person is available every day until told otherwise: untick the days they
   * can't do, or add time away (Planning Center blockouts come in as away
   * dates). Rosters only use the dates you pick, so a workplace that only
   * trades on Sundays never needs Sunday ticked person by person.
   * `availableWeekdays` is passed when the days were actually stated (typed
   * alongside the name in a pasted list); an explicit empty list means none,
   * and makes the roster say "not rostered - no days ticked".
   */
  addPerson(name, availableWeekdays = [0, 1, 2, 3, 4, 5, 6]) {
    const person = {
      id: newId(), orgId: this.data.currentOrgId,
      name: name.trim(), active: true,
      availableWeekdays: [...availableWeekdays],
      blackouts: [], requests: [], maxShifts: null, notes: '',
      roleIds: [],
      withIds: [],          // people they serve together with
      minGapWeeks: null,    // serve at most once every this many weeks (null: no preference)
      weeksOfMonth: [],     // only these weeks of the month, 1-5 (empty: any)
      phone: '', email: '', hourlyRate: null,
    };
    this.data.people.push(person);
    this.save();
    return person;
  },

  /** Apply a patch to one person. */
  updatePerson(id, patch) {
    const person = this.data.people.find((p) => p.id === id);
    if (person) Object.assign(person, patch);
    this.save();
  },

  /** Remove a person and any clash rules or swaps that referenced them. */
  deletePerson(id) {
    this.data.people = this.data.people.filter((p) => p.id !== id);
    this.data.clashes = this.data.clashes.filter((c) => c.a !== id && c.b !== id);
    this.data.swaps = this.data.swaps.filter((w) => w.fromId !== id && w.toId !== id);
    for (const p of this.data.people) {
      if (p.withIds?.includes(id)) p.withIds = p.withIds.filter((x) => x !== id);
    }
    this.save();
  },

  /**
   * Make two people serve together (or stop). Kept on both people, so either
   * one's page shows it and the scheduler finds it from whoever it picks first.
   */
  setTogether(a, b, on) {
    const pa = this.data.people.find((p) => p.id === a);
    const pb = this.data.people.find((p) => p.id === b);
    if (!pa || !pb || a === b) return;
    const set = (p, other) => {
      const ids = new Set(p.withIds || []);
      if (on) ids.add(other); else ids.delete(other);
      p.withIds = [...ids];
    };
    set(pa, b);
    set(pb, a);
    this.save();
  },

  /**
   * Toggle a date a person has asked to work.
   *
   * A request is a preference, not a guarantee: the scheduler puts them on
   * ahead of others that day, but hard constraints and a full shift still win.
   */
  toggleRequest(personId, date) {
    const person = this.data.people.find((p) => p.id === personId);
    if (!person) return;
    if (!Array.isArray(person.requests)) person.requests = [];
    const at = person.requests.indexOf(date);
    if (at >= 0) person.requests.splice(at, 1);
    else person.requests.push(date);
    person.requests.sort();
    this.save();
  },

  /**
   * How a single date stands for one person: 'wants', 'cant', 'cant-range'
   * or 'neutral'.
   *
   * 'cant-range' means the date falls inside a multi-day away period. That is
   * reported separately because a single tap must not silently carve a hole in
   * a range the user entered as one block - those are edited under People.
   */
  dateState(personId, date) {
    const person = this.data.people.find((p) => p.id === personId);
    if (!person) return 'neutral';
    const covering = (person.blackouts || []).find((b) => b.start <= date && date <= b.end);
    if (covering) return covering.start === covering.end ? 'cant' : 'cant-range';
    return (person.requests || []).includes(date) ? 'wants' : 'neutral';
  },

  /** Remove a single-day away date. Returns false if none matched exactly. */
  removeBlackoutOnDate(personId, date) {
    const person = this.data.people.find((p) => p.id === personId);
    if (!person) return false;
    const at = (person.blackouts || []).findIndex((b) => b.start === date && b.end === date);
    if (at < 0) return false;
    person.blackouts.splice(at, 1);
    this.save();
    return true;
  },

  /** Remove every request and away date that fell before `before` (ISO date). */
  clearPastDates(before) {
    let removed = 0;
    for (const person of this.data.people) {
      const requests = (person.requests || []).filter((d) => d >= before);
      removed += (person.requests || []).length - requests.length;
      person.requests = requests;

      const blackouts = (person.blackouts || []).filter((b) => b.end >= before);
      removed += (person.blackouts || []).length - blackouts.length;
      person.blackouts = blackouts;
    }
    if (removed) this.save();
    return removed;
  },

  /** Mark a person unavailable across an inclusive date range. */
  addBlackout(personId, start, end, reason = '') {
    const person = this.data.people.find((p) => p.id === personId);
    if (!person) return;
    if (end < start) [start, end] = [end, start];
    person.blackouts.push({ start, end, reason });
    person.blackouts.sort((x, y) => x.start.localeCompare(y.start));
    this.save();
  },

  /**
   * Swap every away date a person got from `source` (e.g. 'pco') for `ranges`.
   *
   * Imported dates are tagged with where they came from, so a refresh can
   * replace them wholesale - a blockout deleted in Planning Center disappears
   * here too - without touching away dates typed in by hand.
   */
  replaceSourcedBlackouts(personId, source, ranges) {
    const person = this.data.people.find((p) => p.id === personId);
    if (!person) return;
    person.blackouts = [
      ...(person.blackouts || []).filter((b) => b.source !== source),
      ...ranges.map((r) => ({ start: r.start, end: r.end, reason: r.reason || '', source })),
    ].sort((x, y) => x.start.localeCompare(y.start));
    this.save();
  },

  /** Remove one blackout range by its position in the person's list. */
  deleteBlackout(personId, index) {
    const person = this.data.people.find((p) => p.id === personId);
    if (person) person.blackouts.splice(index, 1);
    this.save();
  },

  // ---------------------------------------------------------------- clashes --
  /** Person-id pairs in the current organisation that must not share a shift. */
  clashes() {
    return this.data.clashes
      .filter((c) => c.orgId === this.data.currentOrgId)
      .map((c) => [c.a, c.b]);
  },

  /** Record a clash. Pairs are stored unordered so they cannot be duplicated. */
  addClash(a, b) {
    if (a === b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const exists = this.data.clashes.some(
      (c) => c.orgId === this.data.currentOrgId && c.a === lo && c.b === hi
    );
    if (!exists) this.data.clashes.push({ orgId: this.data.currentOrgId, a: lo, b: hi });
    this.save();
  },

  /** Remove a clash, whichever order the pair is given in. */
  deleteClash(a, b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    this.data.clashes = this.data.clashes.filter(
      (c) => !(c.orgId === this.data.currentOrgId && c.a === lo && c.b === hi)
    );
    this.save();
  },

  // ---------------------------------------------------------------- rosters --
  /** Saved rosters and drafts for the current organisation, most recent first. */
  rosters() {
    return this.data.rosters
      .filter((r) => r.orgId === this.data.currentOrgId)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  },

  /** One saved roster or draft by id, or null. */
  roster(id) {
    return this.data.rosters.find((r) => r.id === id) || null;
  },

  /** Persist a generated roster and return it with its new id. */
  saveRoster(roster) {
    const now = new Date().toISOString();
    const saved = { ...roster, id: newId(), createdAt: now, updatedAt: now };
    this.data.rosters.push(saved);
    this.save();
    return saved;
  },

  /** Apply a patch to a saved roster or draft (e.g. manually edited assignments). */
  updateRoster(id, patch) {
    const r = this.data.rosters.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    this.save();
  },

  /** Delete a saved roster or draft. */
  deleteRoster(id) {
    this.data.rosters = this.data.rosters.filter((r) => r.id !== id);
    this.save();
  },

  // --------------------------------------------------------------- settings --
  /** Read a setting. */
  setting(key) {
    const local = DEVICE_SETTINGS[key];
    if (!local) return this.data.settings[key];
    let mine = '';
    try { mine = localStorage.getItem(local) || ''; } catch { /* storage blocked: none kept */ }
    // One saved by an older version sits in the synced data: take it out of the sync, keeping it here
    // unless this device already has its own.
    if (key in this.data.settings) {
      mine = mine || this.data.settings[key] || '';
      this.setSetting(key, mine);
    }
    return mine;
  },

  /** Write a setting (a device-only one to its own entry, see DEVICE_SETTINGS). */
  setSetting(key, value) {
    const local = DEVICE_SETTINGS[key];
    if (!local) {
      this.data.settings[key] = value;
      this.save();
      return;
    }
    try {
      if (value) localStorage.setItem(local, value); else localStorage.removeItem(local);
    } catch { /* storage blocked: the key just isn't kept */ }
    if (key in this.data.settings) {
      delete this.data.settings[key];
      this.save();
    }
  },

  // ------------------------------------------------------- backup / restore --
  /**
   * The whole database as a formatted JSON string, for the Export button.
   * This is the backup: browser storage can be cleared by the browser itself,
   * so an occasional export to Files/Drive is the only real safety net.
   */
  exportJSON(extra = {}) {
    this.data.lastBackup = new Date().toISOString();
    this.save();
    // `extra` carries the sync code. A backup that restores the data but not
    // the identity would leave you looking at your rosters on a device the
    // server has never heard of - so the file holds both.
    return JSON.stringify({ ...this.data, ...extra }, null, 2);
  },

  /**
   * Whole days since the last backup, or null if one has never been taken.
   *
   * Nothing here syncs anywhere, so an occasional export is the only thing
   * standing between a cleared browser and losing the lot. The app uses this
   * to say so at the point it matters, rather than only in the README.
   */
  daysSinceBackup() {
    if (!this.data.lastBackup) return null;
    const then = Date.parse(this.data.lastBackup);
    if (Number.isNaN(then)) return null;
    return Math.floor((Date.now() - then) / 86400000);
  },

  /** True when there is real data at risk and no recent backup of it. */
  backupOverdue(afterDays = 30) {
    if (this.data.people.length === 0 && this.data.rosters.length === 0) return false;
    const days = this.daysSinceBackup();
    return days === null || days >= afterDays;
  },

  /**
   * Replace everything with a previously exported backup.
   * Throws with a readable message if the file is not a RosterWarden export, so the
   * caller can show it verbatim rather than inventing its own wording.
   */
  importJSON(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("That file isn't valid JSON - pick a RosterWarden backup file.");
    }
    if (!parsed || !Array.isArray(parsed.orgs) || !Array.isArray(parsed.people)) {
      throw new Error("That doesn't look like a RosterWarden backup.");
    }
    // The sync code rides along in the file but is not part of the database;
    // the caller decides whether to adopt it.
    const { syncCode, ...data } = parsed;
    this.data = { ...emptyData(), ...data };
    this.data.settings = { ...emptyData().settings, ...(data.settings || {}) };
    if (!this.save()) throw new Error('Restored, but saving to this device failed.');
    this.load();
    return { syncCode: typeof syncCode === 'string' ? syncCode : null };
  },

  /** Wipe everything on this device. Used by Settings > Delete all data. */
  reset() {
    this.data = emptyData();
    // Device-only settings (the AI key) go too: they are part of "all data" on this device.
    for (const local of Object.values(DEVICE_SETTINGS)) {
      try { localStorage.removeItem(local); } catch { /* storage blocked: nothing kept */ }
    }
    this.save();
  },
};
