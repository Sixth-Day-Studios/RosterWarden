/**
 * The staff member's page, reached from their private link.
 *
 * It stands apart from the rest of the app: no tabs, no workplace, no sync of
 * its own. It shows their name and upcoming shifts (as the owner last
 * published them) and a calendar to tap the dates they can't work, plus a
 * note. Saving sends their whole list, encrypted with the key in their link,
 * to their own mailbox; the owner's app picks it up next time it syncs.
 *
 * When the workplace has shift swaps on, they can also ask a colleague to take
 * a shift and answer colleagues' asks; those go in the same mailbox, sent
 * straight away (see "Shift swaps" in js/staff.js).
 */
import { el, fill, monthGrid, dialog, toast } from '../ui.js';
import { todayISO } from '../scheduler.js';
import {
  boxesFor, readBox, writeBox, LinkReplaced, maskEmail, maskMobile,
  openCryptoKey, claimId, claimer, takeClaim, releaseClaim, readClaims,
} from '../staff-link.js';

/** Where this phone remembers its link, so reopening the app comes back here. */
export const STORED_KEY = 'rosterwarden.staff.key';

/** "Sun 1 Nov" for an ISO date. */
function shortDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** Statuses of a swap that is still going (as js/staff.js publishes them). */
const OPEN = ['asked', 'accepted'];

/** "Sun 1 Nov · Cafe 08:00–12:00 · Barista" for a shift on the page. */
function placeText(s) {
  return `${shortDate(s.date)} · ${[s.shift, s.times].filter(Boolean).join(' ')}${s.role ? ` · ${s.role}` : ''}`;
}

/** A fresh random id for a swap ask, so the owner's app can tell asks apart. */
function newSwapId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Their yes or no to one shift: what they last said (here, or as the roster
 * already has it), and buttons to say it or change it. Sent straight away.
 */
function answerRow(s, sent, change) {
  const mine = sent.shiftReplies.find((r) => r.ref === s.ref);
  const yes = mine ? mine.yes : s.reply === 'yes' ? true : s.reply === 'no' ? false : null;
  /** Send this answer, unless it is what they already said. */
  const answer = (value) => {
    if (yes === value) return;
    change(
      () => { sent.shiftReplies = [...sent.shiftReplies.filter((r) => r.ref !== s.ref), { ref: s.ref, yes: value }]; },
      value ? 'Sent: you can do it' : 'Sent: you can\'t do it',
    );
  };
  return el('div', { className: 'spread' }, [
    el('span', {
      className: 'faint',
      textContent: yes === null ? 'Can you do this one?' : yes ? 'You said you can do it' : 'You said you can\'t do it',
    }),
    el('div', { className: 'row-tight' }, [
      el('button', {
        className: yes === true ? 'btn btn-sm btn-primary' : 'btn btn-sm', textContent: 'I can do it',
        'aria-pressed': String(yes === true), onclick: () => answer(true),
      }),
      el('button', {
        className: yes === false ? 'btn btn-sm btn-danger' : 'btn btn-sm', textContent: 'Can\'t do it',
        'aria-pressed': String(yes === false), onclick: () => answer(false),
      }),
    ]),
  ]);
}

/**
 * The "Your upcoming shifts" card. Each shift can be answered yes or no. With
 * swaps on, each can also be offered to a colleague, and says how an ask for
 * it is going; shifts handed over are listed after, so they don't just vanish.
 */
function shiftList(info, swaps, sent, change) {
  const shifts = info.shifts || [];
  const out = swaps?.out || [];
  const handed = out.filter((o) => o.status === 'done');
  if (!shifts.length && !handed.length) return null;
  const org = info.org || 'whoever does the roster';

  const rows = shifts.map((s) => {
    const line = el('div', {}, [
      placeText(s),
      s.note ? el('span', { className: 'faint', textContent: ` · ${s.note}` }) : null,
    ]);
    // Pages published before answers existed have no refs to answer.
    if (!s.ref) return line;
    const reply = answerRow(s, sent, change);
    if (!swaps) return el('div', { className: 'swap-row' }, [line, reply]);

    // An ask still going: say where it is, and let them take it back.
    const ask = sent.swapAsks.find((a) => a.ref === s.ref);
    if (ask) {
      const known = out.find((o) => o.id === ask.id);
      const who = known?.toName || swaps.colleagues.find((c) => c.id === ask.toId)?.name || 'them';
      return el('div', { className: 'swap-row' }, [line, reply, el('div', { className: 'spread' }, [
        el('span', {
          className: 'faint',
          textContent: known?.status === 'accepted'
            ? `${who} said yes · waiting for ${org} to approve`
            : `Asked ${who} to take it · waiting for their answer`,
        }),
        el('button', {
          className: 'btn btn-sm', textContent: 'Cancel ask',
          onclick: () => change(() => { sent.swapAsks = sent.swapAsks.filter((a) => a !== ask); }, 'Ask cancelled'),
        }),
      ])]);
    }

    // Otherwise offer it, saying how the last ask for it ended if it was turned down.
    const last = out.filter((o) => o.ref === s.ref && (o.status === 'declined' || o.status === 'rejected')).pop();
    return el('div', { className: 'swap-row' }, [line, reply, el('div', { className: 'spread' }, [
      el('span', {
        className: 'faint',
        textContent: !last ? '' : last.status === 'declined' ? `${last.toName} said no` : `${org} didn't approve ${last.toName} taking it`,
      }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Ask someone to take it',
        onclick: () => askSomeone(s, swaps, sent, change),
      }),
    ])]);
  });

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Your upcoming shifts' }),
    ...rows,
    ...handed.map((h) => el('div', { className: 'faint', textContent: `${placeText(h)} · ${h.toName} took it` })),
  ]);
}

/**
 * The "Cancelled" card: shifts they said they could do that have since been
 * taken off them, so a shift doesn't just vanish from their list. Each stays
 * until its day has passed. Null when there are none.
 */
function cancelledCard(info) {
  const cancelled = info.cancelled || [];
  if (!cancelled.length) return null;
  return el('div', { className: 'notice' }, [
    el('strong', { textContent: 'Cancelled' }),
    el('div', { className: 'faint', textContent: `${info.org || 'Whoever does the roster'} took these off you, so you're not needed for them:` }),
    ...cancelled.map((c) => el('div', { textContent: placeText(c) })),
  ]);
}

/** Pick a colleague to ask to take `shift`, and send the ask. Anyone can be asked. */
async function askSomeone(shift, swaps, sent, change) {
  const chosen = await dialog((close) => [
    el('h2', { textContent: 'Who could take it?' }),
    el('div', { className: 'faint', textContent: placeText(shift) }),
    swaps.colleagues.length
      ? el('div', { className: 'list' }, swaps.colleagues.map((c) => el('button', {
        type: 'button', className: 'item', onclick: () => close(c),
      }, [el('div', { className: 'item-main' }, [el('div', { className: 'item-title', textContent: c.name })])])))
      : el('div', { className: 'muted', textContent: 'Nobody else on the team has a link yet.' }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
    ]),
  ]);
  if (!chosen) return;
  change(
    () => { sent.swapAsks = [...sent.swapAsks, { id: newSwapId(), ref: shift.ref, toId: chosen.id }]; },
    `Asked ${chosen.name.split(' ')[0]}`,
  );
}

/** Colleagues' asks waiting for their answer, each with Yes and No. Null when there are none. */
function askedOfMe(info, swaps, sent, change) {
  if (!swaps.in?.length) return null;
  const org = info.org || 'whoever does the roster';
  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Can you take these?' }),
    ...swaps.in.map((w) => {
      const answer = sent.swapAnswers.find((a) => a.id === w.id);
      /** Send their answer; it can't be changed once sent. */
      const reply = (accept) => change(
        () => { sent.swapAnswers = [...sent.swapAnswers.filter((a) => a.id !== w.id), { id: w.id, accept }]; },
        accept ? 'Sent: yes' : 'Sent: no',
      );
      return el('div', { className: 'swap-row' }, [
        el('div', { textContent: `${w.fromName} asks: ${placeText(w)}` }),
        answer
          ? el('div', {
            className: 'faint',
            textContent: !answer.accept ? 'You said no'
              : swaps.mode === 'approval' ? `You said yes · waiting for ${org} to approve` : 'You said yes · it\'s yours once the roster updates',
          })
          : el('div', { className: 'row-tight' }, [
            el('button', { className: 'btn btn-sm btn-primary', textContent: 'Yes, I\'ll take it', onclick: () => reply(true) }),
            el('button', { className: 'btn btn-sm', textContent: 'No', onclick: () => reply(false) }),
          ]),
      ]);
    }),
  ]);
}

/**
 * The "Shifts up for grabs" card: shifts sent out before the roster is built,
 * by day. The first to tap "I'll take it" gets a shift, and everyone else then
 * sees who did; one a day each. A day can be turned down as a whole, which
 * marks it as a date they can't work. Taking and letting go happen on the
 * server straight away; `hooks.answered()` tells the owner they answered, and
 * `hooks.setAway(date, on)` marks or unmarks a day they can't work.
 * Returns null when nothing is left to take.
 */
function openShiftsCard(open, linkKey, today, away, hooks) {
  const slots = (open.slots || []).filter((s) => s.date >= today);
  if (!slots.length) return null;
  const node = el('div', { className: 'card' });
  const ids = new Map();
  let held = new Map();
  let me = null;
  let cryptoKey = null;
  let busy = false;

  /** Read who holds each shift now. */
  const load = async () => {
    me = me || await claimer(linkKey);
    cryptoKey = cryptoKey || await openCryptoKey(open.key);
    for (const s of slots) if (!ids.has(s.ref)) ids.set(s.ref, await claimId(open.key, s.ref));
    const found = await readClaims([...ids.values()], cryptoKey);
    held = new Map();
    for (const s of slots) {
      const c = found.get(ids.get(s.ref));
      if (c) held.set(s.ref, { name: c.value?.name || 'someone', mine: c.by === me.by });
    }
  };

  /** Run one change (take, let go, turn a day down) at a time, then redraw from the server. */
  const act = async (work) => {
    if (busy) return;
    busy = true;
    try {
      await work();
    } catch (e) {
      toast(e.message);
    }
    try { await load(); } catch { /* shown as it was */ }
    busy = false;
    draw();
  };

  /** Take a shift, unless someone beat them to it. */
  const take = (s) => act(async () => {
    const ok = await takeClaim(ids.get(s.ref), me.token, cryptoKey, { name: open.me, at: new Date().toISOString() });
    toast(ok ? 'It\'s yours' : 'Sorry, someone took it first');
    if (ok) await hooks.answered();
  });

  /** Let a shift they took go, so someone else can have it. */
  const letGo = (s) => act(async () => {
    await releaseClaim(ids.get(s.ref), me.token);
    toast('Let go');
  });

  /** Turn a whole day down (letting go of a shift taken on it), or undo that. */
  const dayOff = (date, on) => act(async () => {
    if (on) {
      for (const s of slots) if (s.date === date && held.get(s.ref)?.mine) await releaseClaim(ids.get(s.ref), me.token);
    }
    await hooks.setAway(date, on);
  });

  /** One shift's row: what it is, and take it, let it go, or who has it. */
  const slotRow = (s, mineToday) => {
    const h = held.get(s.ref);
    let right;
    if (h?.mine) {
      right = el('div', { className: 'row-tight' }, [
        el('strong', { textContent: 'Yours' }),
        el('button', { className: 'btn btn-sm', textContent: 'Let it go', onclick: () => letGo(s) }),
      ]);
    } else if (h) {
      right = el('span', { className: 'faint', textContent: `Taken by ${h.name}` });
    } else if (away.has(s.date)) {
      right = el('span', { className: 'faint', textContent: 'Free' });
    } else if (mineToday) {
      right = el('span', { className: 'faint', textContent: 'Free · you have one this day' });
    } else {
      right = el('button', { className: 'btn btn-sm btn-primary', textContent: 'I\'ll take it', onclick: () => take(s) });
    }
    return el('div', { className: 'spread' }, [
      el('div', {}, [
        [s.shift, s.times].filter(Boolean).join(' ') + (s.role ? ` · ${s.role}` : ''),
        s.note ? el('span', { className: 'faint', textContent: ` · ${s.note}` }) : null,
      ]),
      right,
    ]);
  };

  /** Draw the card from what is known now. */
  const draw = () => {
    const dates = [...new Set(slots.map((s) => s.date))];
    fill(node, [
      el('div', { className: 'spread' }, [
        el('label', { className: 'label', textContent: 'Shifts up for grabs' }),
        el('button', { className: 'btn btn-sm btn-ghost', textContent: 'Check again', onclick: () => act(async () => {}) }),
      ]),
      el('div', { className: 'faint', textContent: 'First in gets it, one a day. Not free on a day? Say so, so you\'re not put on it.' }),
      ...dates.map((date) => {
        const onDay = slots.filter((s) => s.date === date);
        const mineToday = onDay.some((s) => held.get(s.ref)?.mine);
        const off = away.has(date);
        return el('div', { className: 'swap-row' }, [
          el('div', { className: 'spread' }, [
            el('strong', { textContent: shortDate(date) }),
            off
              ? el('div', { className: 'row-tight' }, [
                el('span', { className: 'faint', textContent: 'You can\'t do this day' }),
                el('button', { className: 'btn btn-sm', textContent: 'Undo', onclick: () => dayOff(date, false) }),
              ])
              : el('button', { className: 'btn btn-sm', textContent: 'Can\'t do this day', onclick: () => dayOff(date, true) }),
          ]),
          ...onDay.map((s) => slotRow(s, mineToday)),
        ]);
      }),
    ]);
  };

  fill(node, el('div', { className: 'muted', textContent: 'Loading shifts up for grabs…' }));
  load().then(draw, () => { held = new Map(); draw(); });
  return { node, redraw: draw };
}

/** Render the staff page for link `key` into `container`. */
export async function render(container, key) {
  document.body.classList.add('staff-mode');
  try { localStorage.setItem(STORED_KEY, key); } catch { /* private mode: fine */ }
  fill(container, el('div', { className: 'card muted', textContent: 'Loading…' }));

  const { inId, outId, cryptoKey } = await boxesFor(key);
  let mine = null;
  let page = null;
  try {
    [mine, page] = await Promise.all([readBox(inId, cryptoKey), readBox(outId, cryptoKey)]);
  } catch (e) {
    if (e instanceof LinkReplaced) {
      try { localStorage.removeItem(STORED_KEY); } catch { /* fine */ }
      fill(container, el('div', { className: 'card' }, [
        el('h2', { textContent: 'This link has been replaced' }),
        el('p', { className: 'muted', textContent: 'Ask whoever does the roster to send you the new one.' }),
      ]));
      return;
    }
    fill(container, el('div', { className: 'card' }, [
      el('h2', { textContent: 'Can\'t load right now' }),
      el('p', { className: 'muted', textContent: e.message }),
      el('button', { className: 'btn btn-primary', textContent: 'Try again', onclick: () => render(container, key) }),
    ]));
    return;
  }

  const info = page?.value || {};
  const today = todayISO();
  // Their own last send wins; a brand-new link starts from what the owner has for them.
  const away = new Set(mine?.value?.awayDates ?? info.awayDates ?? []);
  const first = (info.name || '').split(' ')[0];

  const status = el('div', { className: 'faint' });
  const note = el('textarea', { rows: 2, placeholder: 'Anything to add? (optional)', value: mine?.value?.note || '' });
  const count = el('div', { className: 'muted' });
  /** Say how many upcoming dates are marked. */
  const recount = () => {
    const n = [...away].filter((d) => d >= today).length;
    count.textContent = n ? `${n} upcoming date${n === 1 ? '' : 's'} you can't work` : 'No dates marked yet.';
  };

  // The "Shifts up for grabs" card, made further down once sending is set up.
  let openCard = null;
  const cal = monthGrid({
    start: today,
    classOf: (iso) => (away.has(iso) ? 'is-away' : ''),
    onTap: (iso) => {
      if (iso < today) return;   // the past can't be changed
      if (away.has(iso)) away.delete(iso); else away.add(iso);
      cal.redraw();
      recount();
      openCard?.redraw();
      status.textContent = 'Not saved yet.';
    },
  });
  recount();
  if (mine?.updatedAt) status.textContent = `Last saved ${new Date(mine.updatedAt).toLocaleString()}`;

  // What this page last sent. Every send carries all of it, so asking for a
  // swap never sends dates that haven't been saved, and saving dates never
  // drops a swap.
  const swaps = info.swaps && info.swaps.mode !== 'off' ? info.swaps : null;
  const settled = new Set((swaps?.out || []).filter((o) => !OPEN.includes(o.status)).map((o) => o.id));
  const waiting = new Set((swaps?.in || []).map((w) => w.id));
  const sent = {
    awayDates: [...away],
    note: mine?.value?.note || '',
    // Asks still going (the owner's app forgets finished ones) and answers not yet taken in.
    swapAsks: (mine?.value?.swapAsks || []).filter((a) => !settled.has(a.id)),
    swapAnswers: (mine?.value?.swapAnswers || []).filter((a) => waiting.has(a.id)),
    // Their answers to shifts still on their page; ones for shifts gone are dropped.
    shiftReplies: (mine?.value?.shiftReplies || []).filter((r) => (info.shifts || []).some((s) => s.ref === r.ref)),
    // The open shifts they last answered, so the owner can see who has.
    openReplied: mine?.value?.openReplied || null,
    // Their details. The page is never given their email or mobile (a link can be forwarded), only hints, so
    // those go out blank ("no change") unless they type a new one. One they typed is kept, and resent, only
    // until the owner's app has read it (`seenUpTo`), so a quick second send can't drop it unread.
    profile: {
      name: mine?.value?.profile?.name || info.profile?.name || info.name || '',
      ...(mine && mine.updatedAt > (info.seenUpTo || '')
        ? { email: mine.value?.profile?.email || '', mobile: mine.value?.profile?.mobile || '' }
        : { email: '', mobile: '' }),
    },
  };

  // The details card. Planning Center people have their name and email from there. Email and mobile start
  // empty, with what's on file as a hint; anything typed replaces it.
  const field = (label, key, attrs = {}) => {
    const input = el('input', { type: 'text', value: key === 'name' ? sent.profile.name : '', ...attrs });
    return { input, node: el('div', {}, [el('label', { className: 'label', textContent: label }), input]) };
  };
  const nameField = field('Name', 'name', { maxLength: 80, autocomplete: 'name', disabled: Boolean(info.pco) });
  const emailField = field('Email', 'email', {
    type: 'email', maxLength: 120, autocomplete: 'email', disabled: Boolean(info.pco),
    placeholder: info.profile?.emailHint || 'None on file',
  });
  const mobileField = field('Mobile', 'mobile', {
    type: 'tel', maxLength: 25, autocomplete: 'tel', placeholder: info.profile?.mobileHint || 'None on file',
  });
  const detailsCard = el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Your details' }),
    nameField.node, emailField.node, mobileField.node,
    el('div', { className: 'faint', textContent: 'Your email and mobile are only hinted at here, to keep them private. Type a new one to change it.' }),
    info.pco ? el('div', { className: 'faint', textContent: 'Your name and email come from Planning Center, so change them there.' }) : null,
  ]);

  /** Write everything in `sent` to their mailbox. Throws a readable error. */
  const send = async () => {
    try {
      await writeBox(inId, cryptoKey, sent);
    } catch (e) {
      throw new Error(e instanceof LinkReplaced ? 'This link has been replaced. Ask for the new one.' : e.message);
    }
  };

  const save = el('button', {
    className: 'btn btn-primary btn-lg btn-block', textContent: 'Save',
    onclick: async () => {
      save.disabled = true;
      try {
        sent.awayDates = [...away].filter((d) => d >= today).sort();
        sent.note = note.value.trim().slice(0, 500);
        // Blank email or mobile means no change; one typed earlier and not yet read by the owner is kept.
        sent.profile = {
          name: nameField.input.value.trim(),
          email: emailField.input.value.trim() || sent.profile.email,
          mobile: mobileField.input.value.trim() || sent.profile.mobile,
        };
        await send();
        // Sent: show it as a hint like the rest, rather than leaving it written out on the page.
        if (emailField.input.value.trim()) { emailField.input.placeholder = maskEmail(sent.profile.email) || 'None on file'; emailField.input.value = ''; }
        if (mobileField.input.value.trim()) { mobileField.input.placeholder = maskMobile(sent.profile.mobile) || 'None on file'; mobileField.input.value = ''; }
        status.textContent = `Saved. ${info.org || 'They'} will see it next time they open RosterWarden.`;
      } catch (e) {
        status.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    },
  });

  const shiftsCard = el('div');
  const askedCard = el('div');
  /** Redraw the parts that change with a swap: their shifts, and asks waiting for them. */
  const redraw = () => {
    fill(shiftsCard, shiftList(info, swaps, sent, change));
    fill(askedCard, swaps ? askedOfMe(info, swaps, sent, change) : null);
  };
  /** Apply a swap or answer change to `sent`, send it, and redraw; undone if it couldn't be sent. */
  const change = async (update, done) => {
    const before = { swapAsks: sent.swapAsks, swapAnswers: sent.swapAnswers, shiftReplies: sent.shiftReplies };
    update();
    try {
      await send();
      toast(done);
    } catch (e) {
      Object.assign(sent, before);
      toast(e.message);
    }
    redraw();
  };
  redraw();

  if (info.open) {
    openCard = openShiftsCard(info.open, key, today, away, {
      /** Tell the owner they've answered these open shifts. */
      answered: async () => {
        if (sent.openReplied === info.open.id) return;
        sent.openReplied = info.open.id;
        await send();
      },
      /**
       * Mark or unmark one day they can't work, and send it straight away.
       * Only that day changes in what is sent; other calendar taps still wait for Save.
       */
      setAway: async (date, on) => {
        const before = { awayDates: sent.awayDates, openReplied: sent.openReplied };
        sent.awayDates = [...new Set([...sent.awayDates.filter((d) => d !== date), ...(on ? [date] : [])])].sort();
        sent.openReplied = info.open.id;
        try {
          await send();
        } catch (e) {
          Object.assign(sent, before);
          throw e;
        }
        if (on) away.add(date); else away.delete(date);
        cal.redraw();
        recount();
        toast(on ? 'Sent: you can\'t do that day' : 'Sent: you can do that day');
      },
    });
  }

  fill(container, [
    el('h2', { textContent: first ? `Hi ${first}` : 'Your availability' }),
    el('p', { className: 'muted', textContent: `Say whether you can do each of your shifts: that's sent straight away. Then tap the dates you can't work${info.org ? ` for ${info.org}` : ''} and Save. Tap again to undo.` }),
    swaps ? el('div', { className: 'notice' }, [
      el('strong', { textContent: 'Shift swaps are on' }),
      el('div', {
        textContent: `Can't make a shift? Ask anyone on the team to take it. They say yes or no on their own page, `
          + (swaps.mode === 'approval' ? `then ${info.org || 'whoever does the roster'} approves it.` : 'and a yes hands it over.')
          + ' The roster changes next time it is opened.',
      }),
    ]) : null,
    cancelledCard(info),
    askedCard,
    openCard?.node || null,
    shiftsCard,
    el('div', { className: 'card' }, [
      el('label', { className: 'label', textContent: 'Dates you can\'t work' }),
      cal.node,
      count,
    ]),
    detailsCard,
    el('div', { className: 'card' }, [el('label', { className: 'label', textContent: 'Note' }), note]),
    save,
    status,
    el('p', { className: 'faint', textContent: 'Only you and whoever does the roster can see this. Keep this link to yourself.' }),
    // The exit. It also makes this device forget the page, so opening RosterWarden from its icon shows the
    // ordinary app (someone who does rosters of their own isn't stuck here); their link brings the page back.
    // Browsers only let a page close itself if it opened the tab, so otherwise it says the tab can be closed.
    el('button', {
      className: 'btn btn-ghost btn-block', textContent: 'Close this page',
      onclick: (e) => {
        try { localStorage.removeItem(STORED_KEY); } catch { /* private mode: nothing kept */ }
        window.close();
        e.target.textContent = 'You can close this tab now';
        e.target.disabled = true;
      },
    }),
  ]);
}
