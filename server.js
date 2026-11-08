// Check-in server. No dependencies: Node's built-in http and sqlite only.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ticketKey } = require('./public/parse.js');
const reader = require('./ticket-reader.js');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const USE_HTTP = process.env.USE_HTTP === '1';
const PORT = Number(process.env.PORT || (USE_HTTP ? 3000 : 8443));
const MAX_BODY = 10 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.jpg': 'image/jpeg' };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
// Everyone signs in on one page with a username and PIN. This one opens the admin page;
// scanner accounts are made on the admin page. Set ADMIN_PIN to change it.
const ADMIN_USER = 'admin';
const ADMIN_PIN = process.env.ADMIN_PIN || '111226';
const ADMIN_HASH = sha256(ADMIN_PIN);

const db = new DatabaseSync(path.join(DATA_DIR, 'checkins.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS guests (
    key TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    batch TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    checked_in_at INTEGER,
    checked_in_by TEXT,
    conflicts INTEGER NOT NULL DEFAULT 0,
    listed INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS guests_seq ON guests (seq);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
if (!getMeta.get('epoch')) setMeta.run('epoch', crypto.randomUUID());
if (!getMeta.get('seq')) setMeta.run('seq', '0');
if (!getMeta.get('raffle_version')) setMeta.run('raffle_version', '0');

db.exec(`
  CREATE TABLE IF NOT EXISTS scanners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scanner_sessions (
    token_hash TEXT PRIMARY KEY,
    scanner_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize_id INTEGER NOT NULL,
    guest_key TEXT NOT NULL,
    drawn_at INTEGER NOT NULL,
    void INTEGER NOT NULL DEFAULT 0
  );
`);
// Added after the first release, so older databases get the column here.
if (!db.prepare("SELECT 1 FROM pragma_table_info('guests') WHERE name = 'raffle_excluded'").get()) {
  db.exec('ALTER TABLE guests ADD COLUMN raffle_excluded INTEGER NOT NULL DEFAULT 0');
}

const getGuest = db.prepare('SELECT * FROM guests WHERE key = ?');
const changedSince = db.prepare('SELECT key, number, name, batch, email, checked_in_at, checked_in_by, conflicts, listed FROM guests WHERE seq > ?');
const insertCheckin = db.prepare(`INSERT INTO guests (key, number, name, batch, checked_in_at, checked_in_by, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const updateCheckin = db.prepare(`UPDATE guests SET checked_in_at = ?, checked_in_by = ?,
  name = CASE WHEN name = '' THEN ? ELSE name END, batch = CASE WHEN batch = '' THEN ? ELSE batch END, seq = ? WHERE key = ?`);
const addConflict = db.prepare('UPDATE guests SET conflicts = conflicts + 1, seq = ? WHERE key = ?');
const undoCheckin = db.prepare('UPDATE guests SET checked_in_at = NULL, checked_in_by = NULL, seq = ? WHERE key = ?');
const setEmail = db.prepare('UPDATE guests SET email = ?, seq = ? WHERE key = ?');
const setDetails = db.prepare('UPDATE guests SET name = ?, batch = ?, email = ?, seq = ? WHERE key = ?');
const upsertGuest = db.prepare(`INSERT INTO guests (key, number, name, batch, email, listed, seq) VALUES (?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET number = excluded.number, name = excluded.name, batch = excluded.batch,
    email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE email END, listed = 1, seq = excluded.seq`);

const str = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const seq = Number(getMeta.get('seq').v) + 1;
    const result = fn(seq);
    setMeta.run('seq', String(seq));
    db.exec('COMMIT');
    notifyChange();
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function applyOp(op, seq) {
  const key = ticketKey(str(op.number, 200));
  if (!key) return;
  const existing = getGuest.get(key);
  if (op.type === 'checkin') {
    const at = Number(op.at) || Date.now();
    const by = str(op.device, 60);
    const name = str(op.name, 200);
    const batch = str(op.batch, 100);
    if (!existing) insertCheckin.run(key, str(op.number, 200), name, batch, at, by, seq);
    else if (existing.checked_in_at === null) updateCheckin.run(at, by, name, batch, seq, key);
    // Two scanners admitted the same ticket while out of touch. First to arrive stays the record.
    else if (existing.checked_in_at !== at) addConflict.run(seq, key);
  } else if (op.type === 'undo' && existing) {
    undoCheckin.run(seq, key);
  } else if (op.type === 'email' && existing) {
    setEmail.run(str(op.email, 254), seq, key);
  } else if (op.type === 'edit' && existing) {
    setDetails.run(str(op.name, 200), str(op.batch, 100), str(op.email, 254), seq, key);
  }
}

// A signed-in scanner's name goes on their check-ins, whatever the device calls itself.
function sync(body, scanner) {
  const epoch = getMeta.get('epoch').v;
  const ops = Array.isArray(body.ops) ? body.ops : [];
  // Ops queued before "Clear all data" must not bring cleared guests back.
  if (ops.length && body.epoch === epoch) {
    transaction((seq) => ops.forEach((op) => applyOp(scanner ? { ...op, device: scanner.name } : op, seq)));
  }
  const since = body.epoch === epoch ? Number(body.since) || 0 : 0;
  return {
    epoch, seq: Number(getMeta.get('seq').v), rows: changedSince.all(since), reader: reader.enabled,
    user: scanner ? scanner.name : null,
  };
}

// The photo is only passed through to be read. It is not saved here.
async function readTicketPhoto(body, res) {
  if (!reader.enabled) return json(res, 503, { error: 'Handwriting reading is not set up' });
  const image = String(body.image ?? '');
  if (!image.startsWith('/9j/') || image.length > 7000000 || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return json(res, 400, { error: 'Expected a JPEG photo' });
  }
  try {
    const started = Date.now();
    const read = await reader.readTicket(image);
    // Logged without the name, so the terminal shows the reader is working.
    console.log(`Handwriting reader: read a ticket in ${((Date.now() - started) / 1000).toFixed(1)}s`
      + `${read.name ? '' : ' (no name found)'}${read.batch ? '' : ' (no batch found)'}`);
    json(res, 200, read);
  } catch (err) {
    if (err instanceof reader.AuthenticationError) console.error('Handwriting reader: the API key was rejected.');
    // Shown in full so running out of credit is obvious from the terminal on the night.
    else if (err instanceof reader.APIError) console.error(`Handwriting reader: API error ${err.status}: ${err.message}`);
    else console.error(`Handwriting reader: ${err.message}`);
    json(res, 502, { error: 'Could not read the ticket' });
  }
}

function importGuests(body) {
  const guests = Array.isArray(body.guests) ? body.guests : [];
  let imported = 0;
  transaction((seq) => {
    for (const g of guests) {
      const number = str(g.number, 200);
      const key = ticketKey(number);
      if (!key) continue;
      upsertGuest.run(key, number, str(g.name, 200), str(g.batch, 100), str(g.email, 254), seq);
      imported++;
    }
  });
  return { imported };
}

function clearAll() {
  db.exec('DELETE FROM guests'); // Scanner accounts are kept.
  db.exec('DELETE FROM winners'); // Prizes are kept, so a test run doesn't mean typing them in again.
  bumpRaffle();
  setMeta.run('epoch', crypto.randomUUID());
  setMeta.run('seq', '0');
  notifyChange();
  return { ok: true };
}

function csvCell(value) {
  let s = String(value ?? '');
  // Stops a spreadsheet running a name like "=HYPERLINK(...)" as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvFile(header, rows) {
  return '\uFEFF' + [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

function exportCsv() {
  const rows = db.prepare('SELECT * FROM guests ORDER BY checked_in_at IS NULL, checked_in_at, key').all();
  const prizeOf = new Map(listWinners.all().map((w) => [w.key, w.prize_name]));
  return csvFile(
    ['number', 'name', 'batch', 'email', 'checked_in', 'checked_in_at', 'scanned_by', 'on_guest_list', 'conflicting_scans', 'in_raffle', 'prize_won'],
    rows.map((r) => [
      r.number, r.name, r.batch, r.email, r.checked_in_at ? 'yes' : 'no',
      r.checked_in_at ? new Date(r.checked_in_at).toISOString() : '', r.checked_in_by,
      r.listed ? 'yes' : 'no', r.conflicts,
      r.checked_in_at && !r.raffle_excluded ? 'yes' : 'no', prizeOf.get(r.key) || '',
    ]),
  );
}

function winnersCsv() {
  return csvFile(
    ['prize', 'number', 'name', 'batch', 'email', 'drawn_at'],
    listWinners.all().map((w) => [w.prize_name, w.number, w.name, w.batch, w.email, new Date(w.drawn_at).toISOString()]),
  );
}

// Ten wrong PINs or passwords from one address locks it out for a minute.
const failures = new Map();
function lockedOut(req, res) {
  const record = failures.get(req.socket.remoteAddress);
  if (record && record.count >= 10 && Date.now() - record.last < 60000) {
    json(res, 429, { error: 'Too many wrong attempts. Wait a minute.' });
    return true;
  }
  return false;
}
function noteAttempt(req, ok) {
  const ip = req.socket.remoteAddress;
  if (ok) failures.delete(ip);
  else failures.set(ip, { count: (failures.get(ip)?.count ?? 0) + 1, last: Date.now() });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Sign-in ----
// One sign-in for everyone: admin, or a scanner account made on the admin page.

const sha256hex = (value) => sha256(value).toString('hex');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

function pinMatches(pin, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pin), salt, 32), Buffer.from(hash, 'hex'));
}

const DUMMY_PIN_HASH = hashPin('000000');
const getScannerByUsername = db.prepare('SELECT * FROM scanners WHERE username = ?');
const getScanner = db.prepare('SELECT * FROM scanners WHERE id = ?');
const sessionScanner = db.prepare(`SELECT s.* FROM scanner_sessions t JOIN scanners s ON s.id = t.scanner_id
  WHERE t.token_hash = ? AND s.active = 1`);
const insertSession = db.prepare('INSERT INTO scanner_sessions (token_hash, scanner_id, created_at) VALUES (?, ?, ?)');
const deleteSession = db.prepare('DELETE FROM scanner_sessions WHERE token_hash = ?');
const deleteSessionsOf = db.prepare('DELETE FROM scanner_sessions WHERE scanner_id = ?');

// Returns the signed-in scanner, or answers 401 and returns null.
function staffAllowed(req, res) {
  const scanner = sessionScanner.get(sha256hex(String(req.headers['x-staff-token'] ?? '')));
  if (scanner) return scanner;
  json(res, 401, { error: 'Please sign in.' });
  return null;
}

const cleanUsername = (value) => String(value ?? '').trim().toLowerCase();

// The answer's role tells the page where to go: the admin page or the scanner.
function login(body, req, res) {
  if (lockedOut(req, res)) return;
  const username = cleanUsername(body.username);
  if (username === ADMIN_USER) {
    const ok = crypto.timingSafeEqual(sha256(String(body.pin ?? '').trim()), ADMIN_HASH);
    noteAttempt(req, ok);
    if (!ok) return json(res, 401, { error: 'Wrong username or PIN' });
    const token = crypto.randomBytes(32).toString('base64url');
    insertAdminSession.run(sha256hex(token), Date.now() + SESSION_DAYS * 86400000);
    return json(res, 200, { role: 'admin', token });
  }
  const scanner = getScannerByUsername.get(username);
  // Hash even for an unknown name, so timing doesn't reveal which usernames exist.
  const ok = pinMatches(body.pin ?? '', scanner?.pin_hash ?? DUMMY_PIN_HASH) && Boolean(scanner?.active);
  noteAttempt(req, ok);
  if (!ok) {
    const disabled = scanner && !scanner.active && pinMatches(body.pin ?? '', scanner.pin_hash);
    return json(res, 401, { error: disabled ? 'This account is turned off. Ask the admin.' : 'Wrong username or PIN' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  insertSession.run(sha256hex(token), scanner.id, Date.now());
  bumpRaffle();
  json(res, 200, { role: 'scanner', token, name: scanner.name });
}

function staffLogout(req, res) {
  deleteSession.run(sha256hex(req.headers['x-staff-token']));
  bumpRaffle();
  json(res, 200, { ok: true });
}

function newPin(given) {
  const pin = String(given ?? '').trim() || String(crypto.randomInt(100000, 1000000));
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'A PIN must be 4 to 8 digits.');
  return pin;
}

function addScanner(body) {
  const name = str(body.name, 60);
  const username = cleanUsername(body.username);
  if (!name) throw new HttpError(400, 'Enter the name to show on records.');
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw new HttpError(400, 'Usernames are 2 to 30 letters or numbers, with no spaces.');
  if (username === ADMIN_USER) throw new HttpError(409, 'The username admin is kept for the admin.');
  const pin = newPin(body.pin);
  try {
    db.prepare('INSERT INTO scanners (username, name, pin_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, name, hashPin(pin), Date.now());
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new HttpError(409, /username/.test(err.message) ? `The username ${username} is taken.` : `Someone is already called ${name}.`);
    throw err;
  }
  bumpRaffle();
  return { username, name, pin };
}

function scannerOrFail(id) {
  const scanner = getScanner.get(Number(id));
  if (!scanner) throw new HttpError(404, 'That scanner account no longer exists.');
  return scanner;
}

function setScannerActive(body) {
  const scanner = scannerOrFail(body.id);
  db.prepare('UPDATE scanners SET active = ? WHERE id = ?').run(body.active ? 1 : 0, scanner.id);
  if (!body.active) deleteSessionsOf.run(scanner.id); // Turning someone off signs them out now.
  bumpRaffle();
  return { ok: true };
}

function resetScannerPin(body) {
  const scanner = scannerOrFail(body.id);
  const pin = newPin(body.pin);
  db.prepare('UPDATE scanners SET pin_hash = ? WHERE id = ?').run(hashPin(pin), scanner.id);
  deleteSessionsOf.run(scanner.id);
  bumpRaffle();
  return { username: scanner.username, name: scanner.name, pin };
}

function deleteScanner(body) {
  const scanner = scannerOrFail(body.id);
  deleteSessionsOf.run(scanner.id);
  db.prepare('DELETE FROM scanners WHERE id = ?').run(scanner.id);
  bumpRaffle();
  return { ok: true };
}

const listScanners = db.prepare(`SELECT s.id, s.username, s.name, s.active, s.created_at,
    (SELECT COUNT(*) FROM scanner_sessions t WHERE t.scanner_id = s.id) AS devices,
    (SELECT COUNT(*) FROM guests g WHERE g.checked_in_by = s.name AND g.checked_in_at IS NOT NULL) AS scans
  FROM scanners s ORDER BY s.name COLLATE NOCASE`);

// ---- Admin and raffle ----

// Saved in the database, so a server restart doesn't log out the raffle screen mid-event.
const SESSION_DAYS = 3;
const insertAdminSession = db.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)');
const getAdminSession = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?');
const deleteAdminSession = db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?');
db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());

function adminTokenValid(token) {
  const session = getAdminSession.get(sha256hex(String(token ?? '')));
  return Boolean(session && session.expires_at > Date.now());
}

function adminAllowed(req, res) {
  if (adminTokenValid(req.headers['x-admin-token'])) return true;
  json(res, 401, { error: 'Please log in again' });
  return false;
}

// ---- Live updates ----
// Admin and raffle screens hold one open connection each, and are told the moment anything changes.

const listeners = new Set();
let notifyQueued = false;

// Several changes in a row become one message, sent once they have all been saved.
function notifyChange() {
  if (notifyQueued) return;
  notifyQueued = true;
  setImmediate(() => {
    notifyQueued = false;
    const message = `data: ${adminVersion()}\n\n`;
    for (const res of listeners) res.write(message);
  });
}

// A comment line every 25 seconds stops idle connections being dropped by phones and routers.
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// EventSource can't send headers, so the token comes in the address. It's only used over HTTPS.
function openEvents(url, res) {
  if (!adminTokenValid(url.searchParams.get('token'))) return json(res, 401, { error: 'Please log in again' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`retry: 2000\ndata: ${adminVersion()}\n\n`);
  listeners.add(res);
  res.on('close', () => listeners.delete(res));
}

const bumpRaffle = () => {
  setMeta.run('raffle_version', String(Number(getMeta.get('raffle_version').v) + 1));
  notifyChange();
};
// Changes whenever anything an admin or raffle screen shows has changed.
const adminVersion = () => [getMeta.get('epoch').v, getMeta.get('seq').v, getMeta.get('raffle_version').v].join(':');

const allGuests = db.prepare('SELECT key, number, name, batch, email, checked_in_at, checked_in_by, listed, raffle_excluded FROM guests');
const listPrizes = db.prepare('SELECT id, name, quantity, position FROM prizes ORDER BY position, id');
const getPrize = db.prepare('SELECT * FROM prizes WHERE id = ?');
const listWinners = db.prepare(`SELECT w.id, w.prize_id, w.guest_key AS key, w.drawn_at, p.name AS prize_name,
    COALESCE(g.number, w.guest_key) AS number, COALESCE(g.name, '') AS name, COALESCE(g.batch, '') AS batch, COALESCE(g.email, '') AS email
  FROM winners w JOIN prizes p ON p.id = w.prize_id LEFT JOIN guests g ON g.key = w.guest_key
  WHERE w.void = 0 ORDER BY p.position, p.id, w.drawn_at`);
// Everyone admitted, not taken out of the draw, and not already a winner.
const rafflePool = db.prepare(`SELECT key, number, name, batch FROM guests
  WHERE checked_in_at IS NOT NULL AND raffle_excluded = 0 AND key NOT IN (SELECT guest_key FROM winners WHERE void = 0)
  ORDER BY key`);
const countWinners = db.prepare('SELECT COUNT(*) AS n FROM winners WHERE prize_id = ? AND void = 0');
const insertWinner = db.prepare('INSERT INTO winners (prize_id, guest_key, drawn_at) VALUES (?, ?, ?)');
const getWinner = db.prepare('SELECT * FROM winners WHERE id = ? AND void = 0');
const voidWinnerRow = db.prepare('UPDATE winners SET void = 1 WHERE id = ?');
const setExcluded = db.prepare('UPDATE guests SET raffle_excluded = ? WHERE key = ?');

function prizesWithWinners({ withEmail }) {
  const winners = listWinners.all();
  return listPrizes.all().map((p) => ({
    ...p,
    winners: winners.filter((w) => w.prize_id === p.id).map((w) => ({
      id: w.id, key: w.key, number: w.number, name: w.name, batch: w.batch, drawn_at: w.drawn_at,
      ...(withEmail ? { email: w.email } : {}),
    })),
  }));
}

function adminState(since) {
  const version = adminVersion();
  if (since === version) return { unchanged: true, version };
  return {
    version, guests: allGuests.all(), prizes: prizesWithWinners({ withEmail: true }), poolSize: rafflePool.all().length,
    scanners: listScanners.all(),
  };
}

// What the public raffle screen needs: no emails.
function raffleState(since) {
  const version = adminVersion();
  if (since === version) return { unchanged: true, version };
  return { version, pool: rafflePool.all(), prizes: prizesWithWinners({ withEmail: false }) };
}

function draw(body) {
  const prize = getPrize.get(Number(body.prizeId));
  if (!prize) throw new HttpError(404, 'That prize no longer exists.');
  if (countWinners.get(prize.id).n >= prize.quantity) {
    throw new HttpError(409, `All ${prize.quantity} ${prize.quantity === 1 ? 'winner' : 'winners'} for ${prize.name} have been drawn.`);
  }
  const pool = rafflePool.all();
  if (!pool.length) throw new HttpError(409, 'Nobody is left in the draw.');
  const winner = pool[crypto.randomInt(pool.length)];
  const { lastInsertRowid } = insertWinner.run(prize.id, winner.key, Date.now());
  bumpRaffle();
  return { id: Number(lastInsertRowid), prize_id: prize.id, ...winner };
}

// Cancels a win so the prize can be drawn again. With removeFromDraw (they're not here to
// claim it) the person also leaves the draw; without it they go straight back in.
function voidWinner(body) {
  const winner = getWinner.get(Number(body.id));
  if (!winner) throw new HttpError(404, 'That winner was already removed.');
  voidWinnerRow.run(winner.id);
  setExcluded.run(body.removeFromDraw ? 1 : 0, winner.guest_key);
  bumpRaffle();
  return { ok: true };
}

function addParticipant(body) {
  const number = str(body.number, 200);
  const key = ticketKey(number);
  if (!key) throw new HttpError(400, 'Enter a ticket number.');
  const email = str(body.email, 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email looks incomplete.');
  const existing = getGuest.get(key);
  if (existing?.checked_in_at) throw new HttpError(409, `Ticket ${existing.number} is already admitted.`);
  transaction((seq) => {
    applyOp({ type: 'checkin', number, name: body.name, batch: body.batch, at: Date.now(), device: 'Admin' }, seq);
    const guest = getGuest.get(key);
    setDetails.run(str(body.name, 200) || guest.name, str(body.batch, 100) || guest.batch, email || guest.email, seq, key);
    setExcluded.run(0, key);
  });
  return { ok: true };
}

function setInDraw(body) {
  const { changes } = setExcluded.run(body.included ? 0 : 1, String(body.key ?? ''));
  if (!changes) throw new HttpError(404, 'That participant no longer exists.');
  bumpRaffle();
  return { ok: true };
}

function prizeFields(body) {
  const name = str(body.name, 120);
  const quantity = Number(body.quantity);
  if (!name) throw new HttpError(400, 'Enter a prize name.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new HttpError(400, 'Number of winners must be from 1 to 500.');
  return { name, quantity };
}

function addPrize(body) {
  const { name, quantity } = prizeFields(body);
  const last = db.prepare('SELECT MAX(position) AS p FROM prizes').get().p ?? 0;
  db.prepare('INSERT INTO prizes (name, quantity, position) VALUES (?, ?, ?)').run(name, quantity, last + 1);
  bumpRaffle();
  return { ok: true };
}

function updatePrize(body) {
  const prize = getPrize.get(Number(body.id));
  if (!prize) throw new HttpError(404, 'That prize no longer exists.');
  const { name, quantity } = prizeFields(body);
  const drawn = countWinners.get(prize.id).n;
  if (quantity < drawn) throw new HttpError(409, `${drawn} winners are already drawn for this prize.`);
  db.prepare('UPDATE prizes SET name = ?, quantity = ? WHERE id = ?').run(name, quantity, prize.id);
  bumpRaffle();
  return { ok: true };
}

function movePrize(body) {
  const prizes = listPrizes.all();
  const from = prizes.findIndex((p) => p.id === Number(body.id));
  const to = from + (body.direction === 'up' ? -1 : 1);
  if (from < 0 || to < 0 || to >= prizes.length) return { ok: true };
  [prizes[from], prizes[to]] = [prizes[to], prizes[from]];
  const setPosition = db.prepare('UPDATE prizes SET position = ? WHERE id = ?');
  prizes.forEach((p, i) => setPosition.run(i + 1, p.id));
  bumpRaffle();
  return { ok: true };
}

function deletePrize(body) {
  const prize = getPrize.get(Number(body.id));
  if (!prize) return { ok: true };
  if (countWinners.get(prize.id).n) throw new HttpError(409, 'This prize has winners. Remove them first.');
  db.prepare('DELETE FROM winners WHERE prize_id = ?').run(prize.id);
  db.prepare('DELETE FROM prizes WHERE id = ?').run(prize.id);
  bumpRaffle();
  return { ok: true };
}

function sendCsv(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const ADMIN_POSTS = {
  '/api/admin/participants': addParticipant,
  '/api/admin/participants/raffle': setInDraw,
  '/api/admin/prizes': addPrize,
  '/api/admin/prizes/update': updatePrize,
  '/api/admin/prizes/move': movePrize,
  '/api/admin/prizes/delete': deletePrize,
  '/api/admin/draw': draw,
  '/api/admin/winners/void': voidWinner,
  '/api/admin/scanners': addScanner,
  '/api/admin/scanners/active': setScannerActive,
  '/api/admin/scanners/reset-pin': resetScannerPin,
  '/api/admin/scanners/delete': deleteScanner,
};

async function handleAdmin(req, res, url) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/api/admin/events') return openEvents(url, res);
  if (!adminAllowed(req, res)) return;
  const since = url.searchParams.get('since') || '';
  if (req.method === 'GET' && pathname === '/api/admin/state') return json(res, 200, adminState(since));
  if (req.method === 'GET' && pathname === '/api/admin/raffle') return json(res, 200, raffleState(since));
  if (req.method === 'GET' && pathname === '/api/admin/export.csv') return sendCsv(res, exportCsv());
  if (req.method === 'GET' && pathname === '/api/admin/winners.csv') return sendCsv(res, winnersCsv());
  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    deleteAdminSession.run(sha256hex(String(req.headers['x-admin-token'] ?? '')));
    return json(res, 200, { ok: true });
  }
  const action = req.method === 'POST' && ADMIN_POSTS[pathname];
  if (!action) return json(res, 404, { error: 'Not found' });
  json(res, 200, action(await readJson(req)));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    return serveStatic(pathname, res);
  }
  try {
    if (pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
    if (req.method === 'POST' && pathname === '/api/login') return login(await readJson(req), req, res);
    if (req.method === 'POST' && pathname === '/api/logout') return staffLogout(req, res);
    const scanner = staffAllowed(req, res);
    if (!scanner) return;
    if (req.method === 'POST' && pathname === '/api/sync') return json(res, 200, sync(await readJson(req), scanner));
    if (req.method === 'POST' && pathname === '/api/read-ticket') return await readTicketPhoto(await readJson(req), res);
    if (req.method === 'POST' && pathname === '/api/import') return json(res, 200, importGuests(await readJson(req)));
    if (req.method === 'POST' && pathname === '/api/clear') return json(res, 200, clearAll());
    if (req.method === 'GET' && pathname === '/api/export.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(exportCsv());
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) json(res, err.status || 400, { error: err.message });
  }
}

function tlsOptions() {
  const key = path.join(DATA_DIR, 'tls-key.pem');
  const cert = path.join(DATA_DIR, 'tls-cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '825', '-subj', '/CN=event-scanner'], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

const server = USE_HTTP ? http.createServer(handle) : https.createServer(tlsOptions(), handle);
server.listen(PORT, () => {
  const scheme = USE_HTTP ? 'http' : 'https';
  console.log(`\nTicket scanner is running.`);
  console.log(`Admin sign-in: username ${ADMIN_USER}, PIN ${process.env.ADMIN_PIN ? '(set by ADMIN_PIN)' : ADMIN_PIN}. Scanners sign in with accounts made on the admin page.\n`);
  console.log(`  This computer: ${scheme}://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Phones on the same Wi-Fi: ${scheme}://${ip}:${PORT}`);
  console.log(`  Admin page: ${scheme}://localhost:${PORT}/admin.html`);
  console.log(`  Raffle screen: ${scheme}://localhost:${PORT}/raffle.html`);
  if (!USE_HTTP) console.log('\nPhones will warn about the certificate once. Choose Advanced > Proceed. The camera needs HTTPS.');
  console.log(`\nHandwriting reader: ${reader.enabled ? 'on' : 'off (no ANTHROPIC_API_KEY set, staff type name and batch)'}`);
  console.log(`\nRecords are saved in ${path.join(DATA_DIR, 'checkins.db')}\n`);
});
