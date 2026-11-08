// Scanner client. Every scan is decided from the local copy of the list, so the door never
// waits on the network; a background loop sends the results to the server and collects
// what other scanners did.
const { parseTicket, ticketKey, parseGuestCsv } = TicketParse;

const $ = (id) => document.getElementById(id);
const STORE = 'ticket-scanner-v1';
const SYNC_INTERVAL = 3000;
const SAME_CODE_QUIET = 4000; // A code held in frame must not read as a duplicate of itself.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const state = {
  guests: new Map(),
  queue: [],
  since: 0,
  epoch: null,
  pin: '', // The shared staff PIN, when signed in with that.
  token: '', // A personal scanner login from the admin page.
  user: '', // That login's name, which the server puts on check-ins.
  device: 'Scanner ' + Math.random().toString(36).slice(2, 5).toUpperCase(),
  reader: false, // Whether the server can read handwriting from a photo.
};

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (!saved) return;
    state.guests = new Map(saved.guests);
    state.queue = saved.queue || [];
    state.since = saved.since || 0;
    state.epoch = saved.epoch || null;
    state.pin = saved.pin || '';
    state.token = saved.token || '';
    state.user = saved.user || '';
    state.device = saved.device || state.device;
  } catch {}
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORE, JSON.stringify({
      guests: [...state.guests], queue: state.queue, since: state.since,
      epoch: state.epoch, pin: state.pin, token: state.token, user: state.user, device: state.device,
    }));
  } catch {}
}

// ---- Local records ----

function applyLocal(op) {
  const key = ticketKey(op.number);
  let guest = state.guests.get(key);
  if (op.type === 'checkin') {
    if (!guest) {
      guest = { key, number: op.number, name: '', batch: '', email: '', checked_in_at: null, checked_in_by: null, conflicts: 0, listed: 0 };
      state.guests.set(key, guest);
    }
    guest.name ||= op.name || '';
    guest.batch ||= op.batch || '';
    if (guest.checked_in_at === null) {
      guest.checked_in_at = op.at;
      guest.checked_in_by = op.device;
    }
  } else if (guest && op.type === 'undo') {
    guest.checked_in_at = null;
    guest.checked_in_by = null;
  } else if (guest && op.type === 'email') {
    guest.email = op.email;
  } else if (guest && op.type === 'edit') {
    guest.name = op.name;
    guest.batch = op.batch;
    guest.email = op.email;
  }
}

function record(op) {
  applyLocal(op);
  state.queue.push(op);
  saveNow(); // A check-in must survive the browser being closed straight after.
  renderCounts();
  syncNow();
}

const hasGuestList = () => [...state.guests.values()].some((g) => g.listed);

// ---- Sync ----

let syncing = false;
let syncAgain = false;
let online = false;

function renderSync() {
  const el = $('sync-status');
  const pending = state.queue.length;
  if (!online) {
    el.dataset.state = 'offline';
    el.textContent = pending ? `Offline, ${pending} saved here` : 'Offline';
  } else if (pending) {
    el.dataset.state = 'syncing';
    el.textContent = `Sending ${pending}`;
  } else {
    el.dataset.state = 'ok';
    el.textContent = 'All saved';
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(state.token ? { 'x-staff-token': state.token } : { 'x-pin': state.pin }),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 429) {
    const { error } = await res.json().catch(() => ({}));
    const hadLogin = Boolean(state.pin || state.token);
    if (res.status === 401) {
      state.token = ''; // Turned off or deleted by the admin, or a new PIN was set.
      state.user = '';
      saveNow();
    }
    showPinGate(hadLogin ? error : '');
    throw new Error(error);
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
  return res;
}

async function syncNow() {
  if (!$('pin-gate').hidden) return; // Polling with a bad PIN would trip the lockout.
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  const sent = state.queue.length;
  try {
    const res = await api('/api/sync', { ops: state.queue.slice(0, sent), since: state.since, epoch: state.epoch });
    const data = await res.json();
    state.reader = data.reader;
    if ((data.user || '') !== state.user) {
      state.user = data.user || '';
      renderWho();
    }
    if (data.epoch !== state.epoch) {
      // Someone cleared all data, so queued scans are void. On first contact (no epoch yet)
      // the server ignored the ops, and they stay queued for the next sync.
      if (state.epoch !== null) state.queue = [];
      state.guests = new Map();
      state.epoch = data.epoch;
      state.since = 0;
    } else {
      state.queue.splice(0, sent);
    }
    for (const row of data.rows) state.guests.set(row.key, row);
    state.since = data.seq;
    state.queue.forEach(applyLocal); // Scans made while this request was in flight.
    online = true;
    saveStore();
    renderCounts();
    if (!$('tab-guests').hidden) renderGuests();
  } catch {
    online = false;
  } finally {
    syncing = false;
    renderSync();
    if (syncAgain) { syncAgain = false; syncNow(); }
  }
}

// ---- Scan handling ----

let current = null; // The guest whose result card is showing.
let opened = null; // Their details when the card opened, so only real changes are saved.
let hideTimer = null;
const CARD_FIELDS = ['card-name', 'card-batch', 'card-email'];

// The QR holds "297" where the ticket prints "000297". Show what staff can see on the paper.
const ticketLabel = (number) => (/^\d+$/.test(number) ? number.padStart(6, '0') : number);

function handleTicket(text, fromCamera = false) {
  // Scanning the next person saves this card, so the line never waits on a button.
  const note = saveCard();
  admit(text, fromCamera);
  $('result-note').textContent = note;
}

function admit(text, fromCamera) {
  const parsed = parseTicket(text);
  const key = ticketKey(parsed.number);
  if (!key) return;

  let guest = state.guests.get(key);
  if (!guest && hasGuestList()) {
    feedback('bad');
    showResult('bad', 'NOT ON THE LIST', `Ticket ${ticketLabel(parsed.number)}`, '', null);
    return;
  }
  // Raffle QRs hold only digits, so this stops a poster or menu QR being admitted as a guest.
  if (!guest && !/^\d+$/.test(key)) {
    feedback('bad');
    showResult('bad', 'NOT A RAFFLE TICKET', 'Unknown QR code', parsed.number.slice(0, 60), null);
    return;
  }
  if (guest?.checked_in_at) {
    feedback('warn');
    const when = new Date(guest.checked_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    showResult('warn', `ALREADY IN since ${when}`, `Ticket ${ticketLabel(guest.number)}`, `Scanned by ${guest.checked_in_by}`, guest, fromCamera);
    return;
  }
  record({
    type: 'checkin', number: guest?.number || key,
    name: parsed.name, batch: parsed.batch, at: Date.now(), device: state.user || state.device,
  });
  guest = state.guests.get(key);
  feedback('ok');
  showResult('ok', 'ADMITTED', `Ticket ${ticketLabel(guest.number)}`, '', guest, fromCamera);
}

function showResult(kind, title, heading, meta, guest, fromCamera = false) {
  clearTimeout(hideTimer);
  current = guest;
  const card = $('result');
  card.dataset.kind = kind;
  $('result-title').textContent = title;
  $('result-name').textContent = heading;
  $('result-meta').textContent = meta;
  $('undo').hidden = kind !== 'ok';
  $('details-error').textContent = '';
  $('details-form').hidden = !guest;
  $('manual').hidden = Boolean(guest);
  card.hidden = false;
  if (!guest) {
    opened = null;
    hideTimer = setTimeout(hideResult, 4000);
    return;
  }
  opened = { name: guest.name, batch: guest.batch, email: guest.email };
  $('card-name').value = guest.name;
  $('card-batch').value = guest.batch;
  $('card-email').value = guest.email;
  $('card-status').textContent = '';
  CARD_FIELDS.forEach((id) => $(id).classList.remove('from-photo'));
  $('read-photo').hidden = !state.reader;
  if (fromCamera && state.reader && !guest.name) readHandwriting(guest.key);
  // While the photo is being read, a keyboard would only hide the fields about to fill in.
  else if (kind === 'ok') focusFirstEmpty();
}

function focusFirstEmpty() {
  const firstEmpty = CARD_FIELDS.find((id) => !$(id).value);
  if (firstEmpty) $(firstEmpty).focus({ preventScroll: true });
}

// The scan never waits for this. Check-in is already recorded, and anything typed meanwhile is kept.
// force: staff pressed the button, so the reading replaces what's in the fields.
async function readHandwriting(key, { force = false } = {}) {
  const image = capturePhoto();
  if (!image) {
    if (force) $('card-status').textContent = 'The camera is not on, so there is no photo to read.';
    return focusFirstEmpty();
  }
  $('card-status').textContent = 'Reading the handwriting. You can keep going.';
  let read = { name: '', batch: '' };
  let failed = '';
  try {
    read = await (await api('/api/read-ticket', { image })).json();
  } catch (err) {
    failed = err.message;
  }
  applyHandwriting(key, read, { force, failed });
}

function applyHandwriting(key, read, { force = false, failed = '' } = {}) {
  if (current?.key === key) {
    let filled = false;
    for (const [id, value] of [['card-name', read.name], ['card-batch', read.batch]]) {
      if (value && (force || !$(id).value)) {
        $(id).value = value;
        $(id).classList.add('from-photo');
        filled = true;
      }
    }
    $('card-status').textContent = failed ? `Couldn't read the ticket (${failed}). Please type it.`
      : filled ? `Read from the ticket${read.batch ? '' : ' (no batch written)'}. Check it and fix anything wrong.`
      : "Couldn't make out the handwriting. Please type it, or hold the ticket steady and press Read again.";
    if (document.activeElement?.tagName !== 'INPUT') focusFirstEmpty();
    return;
  }
  // Staff already moved on, so fill in whatever they left blank.
  const guest = state.guests.get(key);
  if (!guest?.checked_in_at) return; // Wrong ticket was tapped meanwhile.
  const next = { name: guest.name || read.name, batch: guest.batch || read.batch };
  if (next.name !== guest.name || next.batch !== guest.batch) {
    record({ type: 'edit', number: guest.number, ...next, email: guest.email });
    if (!$('tab-guests').hidden) renderGuests();
  }
}

function hideResult() {
  clearTimeout(hideTimer);
  current = null;
  opened = null;
  document.activeElement?.blur();
  $('result').hidden = true;
  $('manual').hidden = false;
}

// Returns a warning when a half-typed email had to be left out.
function saveCard() {
  if (!current) return '';
  const guest = state.guests.get(current.key);
  if (!guest) return '';
  const typed = {
    name: $('card-name').value.trim(),
    batch: $('card-batch').value.trim(),
    email: $('card-email').value.trim().toLowerCase(),
  };
  const emailOk = !typed.email || EMAIL_RE.test(typed.email);
  // Fields left alone keep the latest value, in case another scanner changed them meanwhile.
  const pick = (field) => (typed[field] !== opened[field] ? typed[field] : guest[field]);
  const next = { name: pick('name'), batch: pick('batch'), email: emailOk ? pick('email') : guest.email };
  if (next.name !== guest.name || next.batch !== guest.batch || next.email !== guest.email) {
    record({ type: 'edit', number: guest.number, ...next });
  }
  return emailOk ? '' : `Email for ticket ${ticketLabel(guest.number)} looked incomplete and was not saved.`;
}

// ---- Feedback ----

let audio = null;
function unlockAudio() {
  audio ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
}

function feedback(kind) {
  const tones = { ok: [880, 0.09], warn: [440, 0.22], bad: [180, 0.4] }[kind];
  navigator.vibrate?.({ ok: 40, warn: [80, 60, 80], bad: [200, 80, 200] }[kind]);
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = kind === 'ok' ? 'sine' : 'square';
  osc.frequency.value = tones[0];
  gain.gain.value = 0.25;
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + tones[1]);
}

// ---- Camera ----

const video = $('video');
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d', { willReadFrequently: true });
const FRAME_MAX = 1080;
const PHOTO_MAX = 1600;
let stream = null;
let detector = null;
let worker = null;
let lastCode = '';
let lastCodeAt = 0;
let wakeLock = null;

function onDecoded(text) {
  if (!text || !$('edit-form').hidden) return;
  const now = Date.now();
  const repeat = text === lastCode && now - lastCodeAt < SAME_CODE_QUIET;
  lastCode = text;
  lastCodeAt = now;
  // The ticket drifting back into frame must not interrupt typing that person's email.
  if (repeat || (current && ticketKey(parseTicket(text).number) === current.key)) return;
  handleTicket(text, true);
}

function capturePhoto() {
  if (!stream || video.readyState < 2) return null;
  const scale = Math.min(1, PHOTO_MAX / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

function scanLoop() {
  if (stream && !$('tab-scan').hidden && video.readyState >= 2) {
    if (detector) {
      detector.detect(video)
        .then((codes) => { if (codes[0]) onDecoded(codes[0].rawValue); })
        .catch(() => {})
        .finally(() => requestAnimationFrame(scanLoop));
    } else {
      // The whole frame, because the QR sits at the left of the ticket rather than the centre.
      const scale = Math.min(1, FRAME_MAX / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (frame.width !== width) frame.width = width;
      if (frame.height !== height) frame.height = height;
      frameCtx.drawImage(video, 0, 0, width, height);
      const { data } = frameCtx.getImageData(0, 0, width, height);
      worker.postMessage({ pixels: data, width, height }, [data.buffer]);
    }
    return;
  }
  requestAnimationFrame(scanLoop);
}

async function setupDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch {}
  }
  if (!detector) {
    worker = new Worker('decoder.js');
    worker.onmessage = ({ data }) => {
      onDecoded(data);
      requestAnimationFrame(scanLoop);
    };
    worker.onerror = () => {
      $('camera-message').textContent = 'The QR reader failed to load. Reload the page, or type ticket numbers below.';
      $('camera-message').hidden = false;
    };
  }
}

async function startCamera() {
  const message = $('camera-message');
  if (!navigator.mediaDevices?.getUserMedia) {
    message.textContent = 'This page has no camera access. Open the https:// address. You can still type ticket numbers below.';
    message.hidden = false;
    return;
  }
  try {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Handwriting needs more detail than the QR does.
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    message.hidden = true;
    const track = stream.getVideoTracks()[0];
    $('torch').hidden = !track.getCapabilities?.().torch;
    keepAwake();
  } catch (err) {
    stream = null;
    message.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission is blocked. Allow it in browser settings, then tap here.'
      : 'Could not start the camera. Tap to try again, or type ticket numbers below.';
    message.hidden = false;
  }
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

let torchOn = false;
$('torch').addEventListener('click', async () => {
  torchOn = !torchOn;
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {}
});
$('camera-message').addEventListener('click', startCamera);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Phones can end the camera while the browser is in the background.
  if (stream && stream.getVideoTracks()[0].readyState !== 'live') startCamera();
  else if (stream) keepAwake();
  syncNow();
});

// ---- Guests tab ----

let guestFilter = 'all';

function renderCounts() {
  const all = [...state.guests.values()];
  const listed = all.filter((g) => g.listed).length;
  $('count-in').textContent = all.filter((g) => g.checked_in_at).length;
  $('count-total').textContent = listed ? ` / ${listed} in` : ' in';
}

function renderGuests() {
  const all = [...state.guests.values()];

  const batches = new Map();
  for (const g of all) {
    const name = g.batch || 'No batch';
    const b = batches.get(name) || { in: 0, total: 0 };
    b.total++;
    if (g.checked_in_at) b.in++;
    batches.set(name, b);
  }
  const stats = [...batches].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, b]) => {
    const chip = document.createElement('span');
    chip.textContent = `${name}: ${b.in}/${b.total}`;
    return chip;
  });
  $('batch-stats').replaceChildren(...stats);

  const query = $('search').value.trim().toLowerCase();
  const matches = all.filter((g) => {
    if (guestFilter === 'in' && !g.checked_in_at) return false;
    if (guestFilter === 'out' && g.checked_in_at) return false;
    if (guestFilter === 'noemail' && (!g.checked_in_at || g.email)) return false;
    return !query || [ticketLabel(g.number), g.name, g.batch, g.email].some((v) => String(v).toLowerCase().includes(query));
  }).sort((a, b) => (b.checked_in_at || 0) - (a.checked_in_at || 0)
    || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

  const LIMIT = 100;
  $('guest-list').replaceChildren(...matches.slice(0, LIMIT).map(guestRow));
  $('guest-note').textContent = !all.length ? 'No guests yet. Import a list in Setup, or start scanning.'
    : !matches.length ? 'No matches.'
    : matches.length > LIMIT ? `Showing ${LIMIT} of ${matches.length}. Search to narrow it down.` : '';
}

function guestRow(guest) {
  const li = document.createElement('li');
  const info = document.createElement('div');
  info.className = 'info';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = guest.name || 'No name yet';
  const sub = document.createElement('div');
  sub.className = 'sub';
  const when = guest.checked_in_at && new Date(guest.checked_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  sub.textContent = [`#${ticketLabel(guest.number)}`, guest.batch, guest.email, when && `in ${when}`, !guest.listed && hasGuestList() && 'not on list']
    .filter(Boolean).join(' · ');
  info.append(who, sub);
  if (guest.conflicts) {
    const flag = document.createElement('div');
    flag.className = 'sub flag';
    flag.textContent = `Scanned on another device too (${guest.conflicts})`;
    info.append(flag);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openEditor(guest));
  li.append(info, edit);
  const action = document.createElement('button');
  action.type = 'button';
  if (guest.checked_in_at) {
    action.textContent = 'Undo';
    action.addEventListener('click', () => {
      record({ type: 'undo', number: guest.number });
      renderGuests();
    });
  } else {
    action.textContent = 'Check in';
    action.className = 'admit';
    action.addEventListener('click', () => {
      showTab('scan');
      handleTicket(guest.number);
    });
  }
  li.append(action);
  return li;
}

// ---- Editing ----

let editing = null;

function openEditor(guest) {
  editing = guest;
  $('edit-number').textContent = `Ticket #${ticketLabel(guest.number)}`;
  $('edit-name').value = guest.name;
  $('edit-batch').value = guest.batch;
  $('edit-email').value = guest.email;
  $('edit-error').textContent = '';
  $('edit-form').hidden = false;
  $('edit-name').focus({ preventScroll: true });
}

function closeEditor() {
  editing = null;
  $('edit-form').hidden = true;
  if (!$('tab-guests').hidden) renderGuests();
}

$('edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('edit-email').value.trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) {
    $('edit-error').textContent = 'That email looks incomplete. Fix it or leave it empty.';
    return;
  }
  record({
    type: 'edit', number: editing.number,
    name: $('edit-name').value.trim(), batch: $('edit-batch').value.trim(), email,
  });
  if (current?.key === editing.key) hideResult();
  closeEditor();
});

$('edit-cancel').addEventListener('click', closeEditor);

// ---- Interface wiring ----

function showTab(name) {
  for (const tab of ['scan', 'guests', 'setup']) $(`tab-${tab}`).hidden = tab !== name;
  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'guests') renderGuests();
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('pointerdown', unlockAudio);

$('manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('manual-input').value.trim();
  $('manual-input').value = '';
  $('manual-input').blur();
  if (value) handleTicket(value);
});

function finishCard() {
  const note = saveCard();
  if (note) {
    $('details-error').textContent = 'That email looks incomplete. Fix it or clear it.';
    feedback('warn');
    return;
  }
  hideResult();
  if (!$('tab-guests').hidden) renderGuests();
}

$('details-form').addEventListener('submit', (e) => {
  e.preventDefault();
  finishCard();
});
[['card-name', 'card-batch'], ['card-batch', 'card-email']].forEach(([from, to]) => {
  $(from).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $(to).focus();
  });
});
CARD_FIELDS.forEach((id) => $(id).addEventListener('input', () => $(id).classList.remove('from-photo')));
document.querySelectorAll('[data-domain]').forEach((chip) => chip.addEventListener('click', () => {
  const input = $('card-email');
  const local = input.value.split('@')[0].trim();
  if (!local) { input.focus(); return; }
  input.value = local + chip.dataset.domain;
  if ($('card-name').value.trim()) finishCard(); // Batch is optional.
}));

$('undo').addEventListener('click', () => {
  if (!current) return;
  record({ type: 'undo', number: current.number });
  lastCode = ''; // The same ticket can be scanned straight back in.
  hideResult();
});

$('search').addEventListener('input', renderGuests);
document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  guestFilter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  renderGuests();
}));

$('device-name').addEventListener('change', (e) => {
  state.device = e.target.value.trim() || state.device;
  e.target.value = state.device;
  saveNow();
});

$('csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const result = $('import-result');
  try {
    const guests = parseGuestCsv(await file.text());
    if (!guests.length) throw new Error('No rows with a ticket number were found in that file.');
    const res = await api('/api/import', { guests });
    const { imported } = await res.json();
    result.textContent = `Imported ${imported} guests from ${file.name}.`;
    await syncNow();
  } catch (err) {
    result.textContent = `Import failed: ${err.message}`;
  }
});

$('export').addEventListener('click', async () => {
  const result = $('export-result');
  try {
    await syncNow();
    const blob = await (await api('/api/export.csv')).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `check-ins-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    result.textContent = state.queue.length ? `Exported, but ${state.queue.length} scans here have not reached the server yet.` : 'Exported.';
  } catch (err) {
    result.textContent = `Export failed: ${err.message}`;
  }
});

// Two taps, so a stray tap at the door can't wipe the night's records.
let clearArmedTimer = null;
function disarmClear() {
  clearTimeout(clearArmedTimer);
  clearArmedTimer = null;
  $('clear').textContent = 'Clear all data';
}
$('clear').addEventListener('click', async () => {
  $('clear-result').textContent = '';
  if (!clearArmedTimer) {
    const count = state.guests.size;
    $('clear').textContent = `Tap again to delete ${count} ${count === 1 ? 'record' : 'records'}`;
    clearArmedTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  try {
    await api('/api/clear', {});
    state.queue = [];
    lastCode = ''; // The same test ticket can be scanned straight away.
    hideResult();
    await syncNow();
    $('import-result').textContent = '';
    $('export-result').textContent = '';
    $('clear-result').textContent = 'All data cleared.';
  } catch (err) {
    $('clear-result').textContent = `Clear failed: ${err.message}`;
  }
});

function showPinGate(message) {
  $('pin-gate').hidden = false;
  $('pin-error').textContent = message;
  ($('user-input').value ? $('pin-input') : $('user-input')).focus();
}

function renderWho() {
  $('signed-in').textContent = state.user
    ? `Signed in as ${state.user}. Your check-ins are recorded under this name.`
    : 'Using the shared staff PIN. Check-ins are recorded under the device name below.';
  $('device-field').hidden = Boolean(state.user);
}

$('read-photo').addEventListener('click', () => {
  if (current) readHandwriting(current.key, { force: true });
});

$('pin-gate').addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockAudio();
  const username = $('user-input').value.trim();
  const pin = $('pin-input').value.trim();
  if (username) {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showPinGate(body.error || 'Sign in failed');
      Object.assign(state, { token: body.token, user: body.name, pin: '' });
    } catch {
      return showPinGate("Can't reach the server. Check the Wi-Fi.");
    }
  } else {
    Object.assign(state, { token: '', user: '', pin });
  }
  $('pin-input').value = '';
  $('pin-gate').hidden = true;
  saveNow();
  renderWho();
  await syncNow();
  if ($('pin-gate').hidden) startCamera();
});

$('sign-out').addEventListener('click', async () => {
  // Unsent scans would otherwise be sent later under the next person's login.
  if (state.queue.length) {
    $('sign-out-result').textContent = `${state.queue.length} scans haven't reached the server yet. Wait for "All saved", then sign out.`;
    return;
  }
  $('sign-out-result').textContent = '';
  if (state.token) {
    fetch('/api/logout', { method: 'POST', headers: { 'x-staff-token': state.token } }).catch(() => {});
  }
  Object.assign(state, { token: '', user: '', pin: '' });
  saveNow();
  hideResult();
  showTab('scan');
  showPinGate('');
});

async function init() {
  loadStore();
  $('device-name').value = state.device;
  renderWho();
  renderCounts();
  renderSync();
  await setupDecoder();
  requestAnimationFrame(scanLoop);
  await syncNow();
  setInterval(syncNow, SYNC_INTERVAL);
  window.addEventListener('pagehide', saveNow);
  if ($('pin-gate').hidden) startCamera();
}

init();
