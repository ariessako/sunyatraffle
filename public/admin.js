// Admin page: participants, exports and prizes. Refreshes every few seconds while open.
const $ = (id) => document.getElementById(id);
const BACKUP_REFRESH_MS = 10000; // Changes are pushed instantly; this only covers a dropped connection.
const ROW_LIMIT = 300;

let data = { version: '', guests: [], prizes: [], poolSize: 0, scanners: [], sharedPin: { pin: '', enabled: true } };
let filter = 'admitted';

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function showError(message) {
  $('error').textContent = message || '';
}

const refresh = oneAtATime(refreshNow);

async function refreshNow() {
  if (!AdminSession.loggedIn()) return;
  try {
    const res = await AdminSession.call(`/api/admin/state?since=${encodeURIComponent(data.version)}`);
    const next = await res.json();
    showError('');
    if (next.unchanged) return;
    data = next;
    render();
  } catch (err) {
    if (AdminSession.loggedIn()) showError(`Can't reach the server: ${err.message}`);
  }
}

// Runs an action, then refreshes straight away so the change shows without waiting.
async function act(action, errorTarget = $('error')) {
  try {
    await action();
    errorTarget.textContent = '';
    await refresh();
    return true;
  } catch (err) {
    errorTarget.textContent = err.message;
    return false;
  }
}

// Each winner's prize and win, keyed by participant.
function winnersByKey() {
  const map = new Map();
  for (const prize of data.prizes) for (const w of prize.winners) map.set(w.key, { prize: prize.name, id: w.id });
  return map;
}

function render() {
  const won = winnersByKey();
  const admitted = data.guests.filter((g) => g.checked_in_at);
  const drawn = data.prizes.reduce((n, p) => n + p.winners.length, 0);
  const slots = data.prizes.reduce((n, p) => n + p.quantity, 0);
  $('stat-admitted').textContent = admitted.length;
  $('stat-pool').textContent = data.poolSize;
  $('stat-prizes').textContent = data.prizes.length;
  $('stat-winners').textContent = slots ? `${drawn} / ${slots}` : '0';
  renderParticipants(won);
  renderPrizes();
  renderScanners();
}

function raffleStatus(guest, won) {
  if (!guest.checked_in_at) return { kind: 'waiting', label: 'Not admitted' };
  if (won.has(guest.key)) return { kind: 'won', label: `Won: ${won.get(guest.key).prize}`, winId: won.get(guest.key).id };
  if (guest.raffle_excluded) return { kind: 'removed', label: 'Removed from draw' };
  return { kind: 'draw', label: 'In the draw' };
}

function renderParticipants(won = winnersByKey()) {
  const query = $('search').value.trim().toLowerCase();
  const rows = data.guests
    .map((g) => ({ g, status: raffleStatus(g, won) }))
    .filter(({ g, status }) => {
      if (filter === 'admitted' && !g.checked_in_at) return false;
      if (filter === 'draw' && status.kind !== 'draw') return false;
      if (filter === 'removed' && status.kind !== 'removed') return false;
      if (filter === 'winners' && status.kind !== 'won') return false;
      if (filter === 'waiting' && g.checked_in_at) return false;
      return !query || [ticketLabel(g.number), g.name, g.batch, g.email].some((v) => String(v).toLowerCase().includes(query));
    })
    .sort((a, b) => (b.g.checked_in_at || 0) - (a.g.checked_in_at || 0)
      || String(a.g.number).localeCompare(String(b.g.number), undefined, { numeric: true }));

  $('participants').replaceChildren(...rows.slice(0, ROW_LIMIT).map(({ g, status }) => participantRow(g, status)));
  $('participants-note').textContent = !data.guests.length ? 'Nobody yet. Participants appear here as tickets are scanned.'
    : !rows.length ? 'No matches.'
    : rows.length > ROW_LIMIT ? `Showing ${ROW_LIMIT} of ${rows.length}. Search to narrow it down.`
    : `${rows.length} ${rows.length === 1 ? 'participant' : 'participants'}`;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function participantRow(guest, status) {
  const tr = document.createElement('tr');
  const raffle = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = `pill ${status.kind}`;
  pill.textContent = status.label;
  raffle.append(pill);

  const actions = cell('', 'action');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small';
  if (status.kind === 'draw') {
    button.textContent = 'Remove from draw';
    button.addEventListener('click', () => act(() => AdminSession.call('/api/admin/participants/raffle', { key: guest.key, included: false })));
  } else if (status.kind === 'removed') {
    button.textContent = 'Add back to draw';
    button.addEventListener('click', () => act(() => AdminSession.call('/api/admin/participants/raffle', { key: guest.key, included: true })));
  } else if (status.kind === 'waiting') {
    button.textContent = 'Admit';
    button.addEventListener('click', () => act(() => AdminSession.call('/api/admin/participants', { number: guest.number })));
  } else if (status.kind === 'won') {
    button.textContent = 'Cancel win';
    button.title = 'Cancels the win and puts them back in the draw';
    confirmTap(button, 'Tap again to cancel win', () => act(() => AdminSession.call('/api/admin/winners/void', { id: status.winId, removeFromDraw: false })));
  }
  if (button.textContent) actions.append(button);

  tr.append(
    cell(ticketLabel(guest.number), 'num'),
    cell(guest.name || '—'),
    cell(guest.batch || '—', 'muted'),
    cell(guest.email || '—', 'muted'),
    cell(guest.checked_in_at ? `${time(guest.checked_in_at)} · ${guest.checked_in_by || ''}` : '—', 'muted'),
    raffle,
    actions,
  );
  return tr;
}

function renderPrizes() {
  const list = $('prizes');
  if (list.querySelector('.editing')) return; // Don't wipe a prize someone is editing.
  list.replaceChildren(...data.prizes.map((prize, i) => prizeItem(prize, i)));
  if (!data.prizes.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'No prizes yet. Add the first one above.';
    list.append(li);
  }
}

function smallButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'small';
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function prizeItem(prize, index) {
  const li = document.createElement('li');
  li.className = 'prize';
  const head = document.createElement('div');
  head.className = 'prize-head';
  const title = document.createElement('h3');
  title.textContent = prize.name;
  const count = document.createElement('span');
  count.className = 'prize-count';
  count.textContent = `${prize.winners.length} of ${prize.quantity} ${prize.quantity === 1 ? 'winner' : 'winners'} drawn`;

  const actions = document.createElement('div');
  actions.className = 'prize-actions';
  const up = smallButton('Move up', () => act(() => AdminSession.call('/api/admin/prizes/move', { id: prize.id, direction: 'up' }), $('prize-result')));
  const down = smallButton('Move down', () => act(() => AdminSession.call('/api/admin/prizes/move', { id: prize.id, direction: 'down' }), $('prize-result')));
  up.disabled = index === 0;
  down.disabled = index === data.prizes.length - 1;
  const edit = smallButton('Edit', () => editPrize(li, prize));
  actions.append(up, down, edit);
  if (!prize.winners.length) {
    const del = smallButton('Delete');
    confirmTap(del, 'Tap again to delete', () => act(() => AdminSession.call('/api/admin/prizes/delete', { id: prize.id }), $('prize-result')));
    actions.append(del);
  }
  head.append(title, count, actions);
  li.append(head);

  if (prize.winners.length) {
    const winners = document.createElement('ul');
    winners.className = 'prize-winners';
    for (const w of prize.winners) {
      const item = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      const number = document.createElement('strong');
      number.textContent = ticketLabel(w.number);
      who.append(number, [w.name || 'No name', w.batch && `Batch ${w.batch}`, w.email].filter(Boolean).join(' · '));
      const when = document.createElement('span');
      when.className = 'prize-count';
      when.textContent = time(w.drawn_at);
      const cancel = smallButton('Cancel win');
      cancel.title = 'Cancels this win and puts them back in the draw';
      confirmTap(cancel, 'Tap again: back in draw', () => act(() => AdminSession.call('/api/admin/winners/void', { id: w.id, removeFromDraw: false }), $('prize-result')));
      const absent = smallButton('Not present');
      absent.title = 'Cancels this win and takes them out of the draw';
      confirmTap(absent, 'Tap again: remove them', () => act(() => AdminSession.call('/api/admin/winners/void', { id: w.id, removeFromDraw: true }), $('prize-result')));
      item.append(who, when, cancel, absent);
      winners.append(item);
    }
    li.append(winners);
  } else {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Not drawn yet.';
    li.append(empty);
  }
  return li;
}

function editPrize(li, prize) {
  li.classList.add('editing');
  const form = document.createElement('form');
  form.className = 'row-form';
  form.noValidate = true;
  form.innerHTML = `
    <label class="grow">Prize <input name="name" maxlength="120" required></label>
    <label class="short">Winners <input name="quantity" type="number" min="1" max="500" required></label>
    <button class="primary" type="submit">Save</button>
    <button type="button" data-cancel>Cancel</button>`;
  form.elements.name.value = prize.name;
  form.elements.quantity.value = prize.quantity;
  const close = () => { li.classList.remove('editing'); renderPrizes(); };
  form.querySelector('[data-cancel]').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await act(() => AdminSession.call('/api/admin/prizes/update', {
      id: prize.id, name: form.elements.name.value, quantity: Number(form.elements.quantity.value),
    }), $('prize-result'));
    if (ok) close();
  });
  li.querySelector('.prize-head').replaceWith(form);
  form.elements.name.focus();
}

// ---- Scanners ----

function renderScanners() {
  const shared = data.sharedPin;
  $('shared-pin').textContent = shared.enabled ? shared.pin : `${shared.pin} (off)`;
  $('shared-toggle').textContent = shared.enabled ? 'Turn off shared PIN' : 'Turn on shared PIN';
  $('scanners').replaceChildren(...data.scanners.map(scannerRow));
  $('scanners-note').textContent = data.scanners.length ? ''
    : 'No scanner accounts yet. Add one for each person scanning tickets.';
}

function showPin(result, verb) {
  $('pin-notice-text').replaceChildren(
    `${result.name} ${verb}. Username `, Object.assign(document.createElement('b'), { textContent: result.username }),
    ', PIN ', Object.assign(document.createElement('b'), { textContent: result.pin }), '. This PIN won\u2019t be shown again.',
  );
  $('pin-notice').hidden = false;
}

function scannerRow(scanner) {
  const tr = document.createElement('tr');
  const status = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = `pill ${scanner.active ? 'on' : 'off'}`;
  pill.textContent = scanner.active ? 'Active' : 'Turned off';
  status.append(pill);

  const actions = cell('', 'action');
  const call = (path, body) => act(() => AdminSession.call(path, body), $('scanner-result'));
  const reset = smallButton('New PIN');
  confirmTap(reset, 'Tap again: signs them out', async () => {
    try {
      const res = await AdminSession.call('/api/admin/scanners/reset-pin', { id: scanner.id });
      showPin(await res.json(), 'has a new PIN');
      $('scanner-result').textContent = '';
      refresh();
    } catch (err) {
      $('scanner-result').textContent = err.message;
    }
  });
  const toggle = smallButton(scanner.active ? 'Turn off' : 'Turn on',
    () => call('/api/admin/scanners/active', { id: scanner.id, active: !scanner.active }));
  const remove = smallButton('Delete');
  confirmTap(remove, 'Tap again to delete', () => call('/api/admin/scanners/delete', { id: scanner.id }));
  const group = document.createElement('div');
  group.className = 'actions';
  group.append(reset, toggle, remove);
  actions.append(group);

  const devices = scanner.devices ? `${scanner.devices} ${scanner.devices === 1 ? 'device' : 'devices'}` : '—';
  tr.append(cell(scanner.name), cell(scanner.username, 'muted mono'), status, cell(devices, 'muted'), cell(String(scanner.scans), 'num'), actions);
  return tr;
}

$('add-scanner').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const res = await AdminSession.call('/api/admin/scanners', Object.fromEntries(new FormData(form)));
    showPin(await res.json(), 'is ready to scan');
    $('scanner-result').textContent = '';
    form.reset();
    refresh();
  } catch (err) {
    $('scanner-result').textContent = err.message;
  }
});
$('pin-notice-close').addEventListener('click', () => { $('pin-notice').hidden = true; });
$('shared-toggle').addEventListener('click', () => act(
  () => AdminSession.call('/api/admin/shared-pin', { enabled: !data.sharedPin.enabled }), $('scanner-result')));

function showView() {
  const view = ['#prizes', '#scanners'].includes(location.hash) ? location.hash.slice(1) : 'participants';
  $('view-participants').hidden = view !== 'participants';
  $('view-prizes').hidden = view !== 'prizes';
  $('view-scanners').hidden = view !== 'scanners';
  document.querySelectorAll('[data-view]').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

window.addEventListener('hashchange', showView);
$('search').addEventListener('input', () => renderParticipants());
document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  renderParticipants();
}));

$('add-participant').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const values = Object.fromEntries(new FormData(form));
  const ok = await act(() => AdminSession.call('/api/admin/participants', values), $('add-result'));
  if (ok) {
    $('add-result').textContent = `Ticket ${ticketLabel(values.number.trim())} is admitted and in the draw.`;
    form.reset();
  }
});

$('add-prize').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const ok = await act(() => AdminSession.call('/api/admin/prizes', {
    name: form.elements.name.value, quantity: Number(form.elements.quantity.value),
  }), $('prize-result'));
  if (ok) {
    form.reset();
    form.elements.name.focus();
  }
});

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
$('export-all').addEventListener('click', () => act(() => AdminSession.download('/api/admin/export.csv', `participants-${stamp()}.csv`)));
$('export-winners').addEventListener('click', () => act(() => AdminSession.download('/api/admin/winners.csv', `winners-${stamp()}.csv`)));
$('logout').addEventListener('click', () => AdminSession.logout());

showView();
AdminSession.start(() => {
  refresh();
  keepLive(refresh, BACKUP_REFRESH_MS);
});
