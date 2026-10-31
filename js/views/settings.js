/**
 * Settings: a hub for everything that isn't building a roster.
 *
 * Three groups, the way InvoiceWarden lays its settings out: your workplace
 * (name and opening hours; people and shifts are on the Team tab), connections to other systems
 * (Planning Center, AI assist), and the app itself (sync and backup, install,
 * about). There is no appearance setting: RosterWarden is dark only.
 */
import { store } from '../store.js';
import { PROVIDERS } from '../ai.js';
import {
  el, fill, toast, confirmDialog, weekdayPicker,
  TIME_STEP_SECONDS,
} from '../ui.js';
import { show, refreshOrgs, refreshAccount } from '../app.js';
import * as planningCenter from './planning-center.js';
import { openWizard } from './wizard.js';
import { canInstall, isInstalled, isIOS, promptInstall } from '../install.js';
import * as staff from '../staff.js';
import * as account from '../account.js';
import { openAskGuardian } from '../askguardian.js';
import { signInButtons } from './account.js';
import { STORED_KEY as STAFF_LINK_KEY } from './staff.js';
import { looksLikeEmail } from '../email.js';

/**
 * Which sub-screen is open, or null for the menu.
 *
 * Settings is a hub rather than one long page: it holds the People and Shifts
 * editors, and stacking those with everything else in one scroll would bury them.
 */
let section = null;

/** The step-by-step guide and FAQ, on the Sixth Day Studios website. */
const HELP_URL = 'https://sixthdaystudios.com/rosterwarden/help';

/** Open the help guide in a new tab, leaving the app where it was. */
function openHelp() {
  window.open(HELP_URL, '_blank', 'noopener');
}

/** The menu, grouped so setting the place up is separated from app settings. */
const MENU = [
  {
    group: 'Your workplace',   // people and shifts have their own Team tab
    items: [
      { id: 'workplace', label: 'Name, email and opening hours', hint: 'The days you trade, where replies go, rename or delete' },
      { id: 'swaps', label: 'Shift swaps', hint: 'Let staff hand their shifts to each other' },
      // Not a section: opens the setup wizard over Settings.
      { id: 'wizard', label: 'Set up a new workplace', hint: 'Step by step: hours, shifts, team and skills', run: () => openWizard() },
    ],
  },
  {
    group: 'Connections',
    items: [
      { id: 'planning-center', label: 'Planning Center', hint: 'Bring in a team and blockouts, send rosters back' },
      { id: 'ai', label: 'AI assist', hint: 'Read availability from a pasted message' },
    ],
  },
  {
    group: 'App',
    items: [
      { id: 'install', label: 'Add to Home Screen', hint: 'One tap away, and working offline' },
      // Not a section: opens the Ask Guardian chat in an overlay.
      { id: 'ask', label: 'Ask Guardian', hint: 'Ask a question and get an answer', run: openAskGuardian },
      // Not a section: opens the website's guide in a new tab.
      { id: 'help', label: 'Help and FAQ', hint: 'Step-by-step guide and common questions', run: openHelp, external: true },
    ],
  },
];

/**
 * Older section names, from links elsewhere in the app and earlier versions,
 * mapped onto the sections that now hold them.
 */
const LEGACY_SECTIONS = {
  hours: 'workplace',
  organisation: 'workplace',
};

/** Sections that describe an organisation, so need one to exist first. */
const NEEDS_ORG = ['workplace', 'swaps'];

/** Open Settings at a particular sub-screen, or at the menu when given null. */
export function openSection(name) {
  const id = LEGACY_SECTIONS[name] || name;
  section = MENU.some((g) => g.items.some((i) => i.id === id)) ? id : null;
}

/** Entry point: the settings menu, or whichever sub-screen is open. */
export function render(container) {
  if (!section) {
    // Delete all data and the account line close the menu, below everything else.
    fill(container, [
      el('h2', { textContent: 'Settings' }), ...renderMenu(container),
      el('div', { className: 'settings-foot' }, [deleteAllButton(), accountFooter(() => render(container))]),
    ]);
    return;
  }

  const item = MENU.flatMap((g) => g.items).find((i) => i.id === section);
  const backBtn = el('button', {
    className: 'btn btn-sm', textContent: '← Settings',
    onclick: () => { section = null; render(container); },
  });
  const header = el('div', { className: 'row-tight' }, [backBtn]);

  // Without this guard the workplace card would edit an organisation that
  // does not exist.
  if (NEEDS_ORG.includes(section) && !store.currentOrg()) {
    fill(container, [
      header,
      el('h2', { textContent: item?.label || 'Settings' }),
      el('div', {
        className: 'card muted',
        textContent: 'Create an organisation first — use the dropdown at the top of the screen.',
      }),
    ]);
    return;
  }

  // No section heading here: every card below already carries its own.
  fill(container, [header, ...renderSectionBody(section, container)]);
}

/** The tappable menu rows. */
function renderMenu(container) {
  return MENU.map((group) => el('div', {}, [
    el('label', { className: 'label', textContent: group.group }),
    el('div', { className: 'list' }, group.items.map((item) => el('button', {
      className: 'item',
      onclick: (e) => {
        if (item.run) { item.run(e.currentTarget); return; }
        section = item.id;
        render(container);
      },
    }, [
      el('div', { className: 'item-main' }, [
        el('div', { className: 'item-title', textContent: item.label }),
        el('div', { className: 'item-sub', textContent: item.hint }),
      ]),
      el('span', { className: 'item-chevron', textContent: item.external ? '↗' : '›', 'aria-hidden': 'true' }),
    ]))),
  ]));
}

/** The cards belonging to one sub-screen. */
function renderSectionBody(name, container) {
  const redraw = () => render(container);
  switch (name) {
    case 'workplace': return [renderWorkplaceCard()];
    case 'swaps': return [renderSwapsCard(redraw)];
    case 'planning-center': return [planningCenter.renderCard(redraw)];
    case 'ai': return [renderAICard()];
    case 'install': return [renderInstallCard(container)];
    default: return [];
  }
}

/**
 * Section: the organisation's name, business email and opening hours, and deleting it.
 * One card for the things you set once about the place itself.
 */
function renderWorkplaceCard() {
  const org = store.currentOrg();
  const nameInput = el('input', { type: 'text', value: org.name });
  nameInput.addEventListener('change', () => {
    const value = nameInput.value.trim();
    if (!value) { nameInput.value = org.name; return; }
    store.renameOrg(org.id, value);
    refreshOrgs();
    toast('Renamed');
  });

  // Where staff replies go when the roster is emailed out (js/email.js).
  const replyInput = el('input', {
    type: 'email', value: org.replyEmail || '', placeholder: account.current()?.email || 'you@yourbusiness.com',
  });
  replyInput.addEventListener('change', () => {
    const value = replyInput.value.trim();
    if (value && !looksLikeEmail(value)) { toast("That doesn't look like an email address"); return; }
    store.updateOrg(org.id, { replyEmail: value });
    toast(value ? 'Saved' : 'Replies will go to your account email');
  });

  const deleteBtn = el('button', {
    className: 'btn btn-danger btn-block', textContent: 'Delete organisation',
    onclick: async () => {
      const ok = await confirmDialog(
        'Delete organisation',
        `This deletes "${org.name}" and all of its people, shifts and saved rosters. This cannot be undone.`
      );
      if (!ok) return;
      store.deleteOrg(org.id);
      refreshOrgs();
      show('roster');
      toast('Organisation deleted');
    },
  });

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Name, email and opening hours' }),
    el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
    el('div', {}, [
      el('label', { className: 'label', textContent: 'Business email for replies' }),
      replyInput,
      el('div', { className: 'faint', textContent: 'When you email a roster out, staff replies go here. Leave it empty to use your account email.' }),
    ]),
    renderOpeningHours(org),
    deleteBtn,
  ]);
}

/**
 * Section: whether staff can hand their shifts to each other from their
 * availability links. Two levels, at most one on: a colleague's yes is
 * enough (self swap), or a colleague's yes and then the owner's approval.
 */
function renderSwapsCard(redraw) {
  const org = store.currentOrg();
  const mode = staff.swapMode(org);
  /** One level's switch; turning it on turns the other off. */
  const level = (value, title, detail) => {
    const box = el('input', {
      type: 'checkbox', checked: mode === value,
      onchange: () => { staff.setSwapMode(org.id, box.checked ? value : 'off'); redraw(); },
    });
    return el('div', {}, [
      el('label', { className: 'row-tight' }, [box, el('strong', { textContent: title })]),
      el('div', { className: 'faint', textContent: detail }),
    ]);
  };
  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Shift swaps' }),
    el('div', {
      className: 'muted',
      textContent: 'Let staff ask anyone on the team to take one of their shifts, from their availability link, '
        + 'whether or not that person is free that day: they may want the extra shift.',
    }),
    level('self', 'Self swap', 'The colleague says yes and the shift is theirs. Nothing for you to do.'),
    level('approval', 'Swap with approval', 'The colleague says yes, then you approve or decline it on the Roster screen.'),
    el('div', {
      className: 'faint',
      textContent: 'Only one can be on at a time. Staff need their own link to ask or be asked, and while swaps are on, '
        + 'everyone with a link can see the names of the others. Swaps reach the roster when this app next checks links.',
    }),
  ]);
}

/**
 * Opening days and hours for the current organisation.
 *
 * The days drive the calendar on the New Roster screen - anything outside is
 * dimmed, and an "All open days" shortcut appears. The hours are used to
 * pre-fill the times when a new shift is added, so the common case needs no
 * typing.
 */
function renderOpeningHours(org) {
  // Same 5-minute granularity as shift times - these pre-fill them, so a
  // finer opening hour would produce a shift time the shift editor can't hold.
  const step = String(TIME_STEP_SECONDS);
  const openTime = el('input', { type: 'time', step, value: org.openTime || '' });
  const closeTime = el('input', { type: 'time', step, value: org.closeTime || '' });

  /** Persist whichever hour field changed. */
  const saveHours = () => {
    store.updateOrg(org.id, { openTime: openTime.value, closeTime: closeTime.value });
  };
  openTime.addEventListener('change', saveHours);
  closeTime.addEventListener('change', saveHours);

  const daysWrap = el('div');
  fill(daysWrap, weekdayPicker(store.openDays(), (days) => {
    store.updateOrg(org.id, { openDays: days });
  }));

  return el('div', {}, [
    el('label', { className: 'label', textContent: 'Open on' }),
    daysWrap,
    el('div', {
      className: 'faint',
      textContent: 'Days you are closed are dimmed on the roster calendar. You can still pick them for a one-off.',
      style: 'margin-top:.35rem',
    }),
    el('label', { className: 'label', textContent: 'Opening hours', style: 'margin-top:.8rem' }),
    el('div', { className: 'grid-2' }, [
      el('div', {}, [el('label', { className: 'faint', textContent: 'Opens' }), openTime]),
      el('div', {}, [el('label', { className: 'faint', textContent: 'Closes' }), closeTime]),
    ]),
    el('div', {
      className: 'faint',
      textContent: 'Used to fill in the times when you add a new shift.',
      style: 'margin-top:.35rem',
    }),
  ]);
}

/** Section: AI provider/model/key used to parse availability notes. */
function renderAICard() {
  const provider = store.setting('aiProvider') || 'gemini';
  const spec = PROVIDERS[provider] || PROVIDERS.gemini;

  const providerSelect = el('select', {}, Object.entries(PROVIDERS).map(([key, p]) =>
    el('option', { value: key, textContent: p.label, selected: key === provider })
  ));

  const modelInput = el('input', {
    type: 'text', value: store.setting('aiModel') || '', placeholder: spec.defaultModel,
    onblur: () => store.setSetting('aiModel', modelInput.value.trim()),
  });

  const keyInput = el('input', {
    type: 'password', value: store.setting('aiKey') || '',
    onblur: () => store.setSetting('aiKey', keyInput.value.trim()),
  });
  const showHideBtn = el('button', {
    className: 'btn btn-sm', textContent: 'Show',
    onclick: () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      showHideBtn.textContent = hidden ? 'Hide' : 'Show';
    },
  });

  const keyLink = el('a', {
    href: spec.keyUrl, target: '_blank', rel: 'noopener', textContent: 'Get a key',
  });

  providerSelect.addEventListener('change', () => {
    store.setSetting('aiProvider', providerSelect.value);
    const newSpec = PROVIDERS[providerSelect.value];
    modelInput.placeholder = newSpec.defaultModel;
    keyLink.href = newSpec.keyUrl;
  });

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'AI assist' }),
    el('p', { className: 'muted' }, [
      'AI is only used to turn free-text availability notes into structured days and away-dates. ' +
      'It never decides who works when - the roster itself is worked out by a fixed set of rules ' +
      'that always give the same answer.',
    ]),
    el('div', {}, [el('label', { className: 'label', textContent: 'Provider' }), providerSelect]),
    el('div', {}, [el('label', { className: 'label', textContent: 'Model' }), modelInput]),
    el('div', {}, [
      el('label', { className: 'label', textContent: 'API key' }),
      el('div', { className: 'row-tight' }, [keyInput, showHideBtn]),
    ]),
    keyLink,
    el('div', {
      className: 'faint',
      textContent: 'The key is stored on this device only, and is readable by anyone who can use this ' +
        'device. Fine for personal use - avoid it on a shared phone.',
    }),
  ]);
}

/**
 * Section: put RosterWarden on the home screen.
 *
 * Three states, because the platforms genuinely differ: already installed,
 * installable via the browser's own prompt, or iOS - where no such API exists
 * and the only truthful option is to show the steps.
 */
function renderInstallCard(container) {
  const blurb = el('div', {
    className: 'muted',
    textContent: 'Installed, RosterWarden opens full screen with its own icon and works '
      + 'with no signal at all. This is not an app-store download - nothing lands on '
      + 'the phone but a shortcut and the page itself.',
  });

  if (isInstalled()) {
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Add to Home Screen' }),
      el('div', { className: 'notice', textContent: 'Already installed — you are using it right now.' }),
      blurb,
    ]);
  }

  if (canInstall()) {
    const btn = el('button', {
      className: 'btn btn-primary btn-block btn-lg', textContent: 'Add to Home Screen',
      onclick: async () => {
        const accepted = await promptInstall();
        toast(accepted ? 'Added to your home screen' : 'Not added');
        render(container);            // the prompt is spent either way
      },
    });
    return el('div', { className: 'card' }, [
      el('h3', { textContent: 'Add to Home Screen' }), blurb, btn,
    ]);
  }

  // iOS offers no programmatic route, so spell out the Share-sheet steps.
  const steps = isIOS()
    ? ['Tap the Share button at the bottom of Safari.',
       'Scroll down and choose "Add to Home Screen".',
       'Tap Add.']
    : ['Open your browser’s menu.',
       'Choose "Install app" or "Add to Home screen".',
       'Confirm.'];

  return el('div', { className: 'card' }, [
    el('h3', { textContent: 'Add to Home Screen' }),
    blurb,
    el('ol', { className: 'install-steps' }, steps.map((s) => el('li', { textContent: s }))),
    el('div', {
      className: 'faint',
      textContent: 'If you cannot see the option, it may already be installed, or the '
        + 'browser may not support it — Safari on iPhone and Chrome on Android both do.',
    }),
  ]);
}

/** The red Delete all data button, at the foot of the Settings menu. */
function deleteAllButton() {
  return el('button', {
    className: 'btn btn-danger btn-block', textContent: 'Delete all data',
    onclick: async () => {
      const ok = await confirmDialog(
        'Delete all data',
        'This permanently deletes every organisation, person, shift and saved roster on this device, and switches off '
          + 'every staff link you have sent. There is no undo.',
        'Delete everything'
      );
      if (!ok) return;
      // Switch the staff links off on the server while their keys are still here; offline, say what that means.
      try {
        await staff.retireAllLinks();
      } catch {
        const anyway = await confirmDialog(
          'Staff links still on',
          'The server couldn\'t be reached, so the staff links you sent will keep showing their old shifts. '
            + 'Delete everything anyway, or wait until you\'re online?',
          'Delete anyway'
        );
        if (!anyway) return;
      }
      store.reset();
      // A staff link this phone opened is forgotten too, so the welcome screen stops offering "Open my staff page".
      try { localStorage.removeItem(STAFF_LINK_KEY); } catch { /* private mode: nothing kept */ }
      refreshOrgs();
      show('roster');
      toast('All data deleted');
    },
  });
}

/**
 * The account line under Delete all data, last on the Settings menu: who is signed in and a Sign out link, or
 * the Sign in and Sign up buttons. Null where the app has no account server.
 */
function accountFooter(redraw) {
  if (!account.isConfigured()) return null;
  const who = account.current();
  if (!who) {
    const err = el('div', { className: 'err' });
    return el('div', { className: 'settings-account' }, [
      el('div', { className: 'muted', textContent: 'Sign in and your rosters come back on any phone.' }),
      err,
      signInButtons(err, redraw),
    ]);
  }
  return el('div', { className: 'settings-account' }, [
    el('div', { className: 'muted', textContent: `Signed in as ${who.email}` }),
    el('button', {
      type: 'button', className: 'link-btn', textContent: 'Sign out',
      onclick: async () => {
        const ok = await confirmDialog('Sign out?', 'Your rosters stay on this device and keep syncing. Sign in again any time.', 'Sign out');
        if (!ok) return;
        account.signOut();
        refreshAccount();
        redraw();
      },
    }),
  ]);
}
