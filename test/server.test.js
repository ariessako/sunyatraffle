const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
let server;
let fakeApi;
const apiRequests = [];
let fakeReply;

// Requests as a signed-in scanner account (made in test.before), whose name is "A".
let staffToken = '';
async function call(url, body, token = staffToken) {
  return fetch(BASE + url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-staff-token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const sync = async (body) => (await call('/api/sync', body)).json();
const login = (username, pin) => fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ username, pin }) });
// The admin PIN is the built-in 111226, since these tests don't set ADMIN_PIN.
const adminLogin = async () => (await (await login('admin', '111226')).json()).token;

let adminToken = '';
async function admin(url, body) {
  return fetch(BASE + url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-admin-token': adminToken, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test.before(async () => {
  // Stands in for the Anthropic API, so tests spend nothing and need no key.
  fakeApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      apiRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(fakeReply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fakeReply.body));
    });
  });
  await new Promise((resolve) => fakeApi.listen(0, '127.0.0.1', resolve));

  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, USE_HTTP: '1', PORT: String(PORT), DATA_DIR: dir, ADMIN_PIN: '',
      ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeApi.address().port}`,
    },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(BASE + '/'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error('server did not start');

  adminToken = await adminLogin();
  await admin('/api/admin/scanners', { name: 'A', username: 'gate-a', pin: '4321' });
  staffToken = (await (await login('gate-a', '4321')).json()).token;
});

test.after(() => {
  server.kill();
  fakeApi.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reads handwriting from a photo and fails cleanly', async () => {
  const message = (stop_reason, text) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }, content: text ? [{ type: 'text', text }] : [],
  });
  const image = '/9j/AAAA';

  fakeReply = { status: 200, body: message('end_turn', '{"name":"Test Person","batch":"2013"}') };
  const ok = await call('/api/read-ticket', { image });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { name: 'Test Person', batch: '2013' });

  const sent = apiRequests.at(-1);
  assert.strictEqual(sent.headers.authorization, 'Bearer test-key');
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.strictEqual(sent.body.model, 'claude-opus-5-5');
  assert.strictEqual(sent.body.fallbacks, 'default');
  assert.strictEqual(sent.body.output_config.format.type, 'json_schema');
  assert.strictEqual(sent.body.messages[0].content[0].source.data, image);

  fakeReply = { status: 200, body: message('refusal') };
  assert.strictEqual((await call('/api/read-ticket', { image })).status, 502);

  fakeReply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } };
  assert.strictEqual((await call('/api/read-ticket', { image })).status, 502);

  const before = apiRequests.length;
  assert.strictEqual((await call('/api/read-ticket', { image: 'not a jpeg' })).status, 400);
  assert.strictEqual((await call('/api/read-ticket', { image }, 'not-a-token')).status, 401);
  assert.strictEqual(apiRequests.length, before);
});

test('one sign-in: admin PIN opens admin, scanner accounts open the scanner', async () => {
  const adminRes = await (await login('Admin ', '111226')).json();
  assert.strictEqual(adminRes.role, 'admin');
  assert.strictEqual((await login('admin', '111227')).status, 401);
  const scannerRes = await (await login('gate-a', '4321')).json();
  assert.strictEqual(scannerRes.role, 'scanner');
  assert.strictEqual(scannerRes.name, 'A');
  assert.strictEqual((await login('gate-a', '0000')).status, 401);
  // Each kind of sign-in only opens its own side.
  assert.strictEqual((await call('/api/admin/state', undefined, scannerRes.token)).status, 401);
  assert.strictEqual((await call('/api/sync', {}, adminRes.token)).status, 401);
  // The old shared staff PIN is gone.
  const pinOnly = await fetch(BASE + '/api/sync', { method: 'POST', headers: { 'x-pin': '1234' }, body: '{}' });
  assert.strictEqual(pinOnly.status, 401);
  // No scanner can take the admin's username.
  assert.strictEqual((await admin('/api/admin/scanners', { name: 'Fake Admin', username: 'admin' })).status, 409);
});

test('API needs a sign-in and static files cannot escape public/', async () => {
  assert.strictEqual((await call('/api/sync', {}, 'not-a-token')).status, 401);
  assert.strictEqual((await fetch(BASE + '/%2e%2e/server.js')).status, 404);
  assert.strictEqual((await fetch(BASE + '/index.html')).status, 200);
});

test('check-in, retry, conflict, email, undo and export', async () => {
  let { epoch } = await sync({});
  await call('/api/import', { guests: [{ number: '0012', name: '=Jo', batch: 'B' }, { number: '13', name: 'Sam', batch: 'B' }] });

  const scan = { type: 'checkin', number: '12', at: 1000, device: 'A' };
  await sync({ epoch, ops: [scan] });
  const retried = await sync({ epoch, ops: [scan] }); // Response lost, client sends again.
  let row = retried.rows.find((r) => r.key === '12');
  assert.strictEqual(row.checked_in_at, 1000);
  assert.strictEqual(row.conflicts, 0);

  const other = await sync({ epoch, ops: [{ type: 'checkin', number: '12', at: 2000, device: 'B' }] });
  row = other.rows.find((r) => r.key === '12');
  assert.strictEqual(row.checked_in_at, 1000);
  assert.strictEqual(row.checked_in_by, 'A');
  assert.strictEqual(row.conflicts, 1);

  const delta = await sync({ epoch, since: other.seq, ops: [{ type: 'email', number: '12', email: 'jo@x.test' }] });
  assert.deepStrictEqual(delta.rows.map((r) => r.email), ['jo@x.test']);

  const csv = await (await call('/api/export.csv')).text();
  assert.match(csv, /0012,'=Jo,B,jo@x\.test,yes,1970-01-01T00:00:01\.000Z,A,yes,1/);

  const edited = await sync({ epoch, since: delta.seq, ops: [{ type: 'edit', number: '12', name: 'Jo Lee', batch: 'C', email: 'jo@x.test' }] });
  assert.strictEqual(edited.rows[0].name, 'Jo Lee');
  assert.strictEqual(edited.rows[0].batch, 'C');
  assert.strictEqual(edited.rows[0].checked_in_at, 1000);

  const undone = await sync({ epoch, ops: [{ type: 'undo', number: '12' }] });
  assert.strictEqual(undone.rows.find((r) => r.key === '12').checked_in_at, null);
  assert.strictEqual(undone.rows.find((r) => r.key === '12').email, 'jo@x.test');
});

test('re-import keeps check-ins, and clearing rejects stale queued scans', async () => {
  let { epoch } = await sync({});
  await sync({ epoch, ops: [{ type: 'checkin', number: '13', at: 3000, device: 'A' }] });
  await call('/api/import', { guests: [{ number: '13', name: 'Sam Renamed', batch: 'C' }] });
  let row = (await sync({ epoch })).rows.find((r) => r.key === '13');
  assert.strictEqual(row.checked_in_at, 3000);
  assert.strictEqual(row.name, 'Sam Renamed');

  await call('/api/clear', {});
  const after = await sync({ epoch, ops: [{ type: 'checkin', number: '13', at: 4000, device: 'A' }] });
  assert.notStrictEqual(after.epoch, epoch);
  assert.deepStrictEqual(after.rows, []);
});

test('admin participants, prizes and a fair draw', async () => {
  adminToken = await adminLogin();
  assert.ok(adminToken);

  const { epoch } = await sync({});
  await sync({ epoch, ops: ['21', '22', '23', '24'].map((n, i) => ({ type: 'checkin', number: n, name: `Guest ${n}`, batch: '2013', at: 9000 + i, device: 'A' })) });
  assert.strictEqual((await admin('/api/admin/participants', { number: '25', name: 'Walk In', batch: '1999', email: 'walk@x.test' })).status, 200);
  assert.strictEqual((await admin('/api/admin/participants', { number: '25' })).status, 409);
  await admin('/api/admin/participants/raffle', { key: '24', included: false });

  let raffle = await (await admin('/api/admin/raffle')).json();
  const inPool = (state) => state.pool.map((g) => g.key).sort();
  assert.deepStrictEqual(inPool(raffle).filter((k) => k >= '21' && k <= '25'), ['21', '22', '23', '25']);
  assert.ok(raffle.pool.every((g) => !('email' in g)));
  const unchanged = await (await admin(`/api/admin/raffle?since=${encodeURIComponent(raffle.version)}`)).json();
  assert.strictEqual(unchanged.unchanged, true);

  assert.strictEqual((await admin('/api/admin/prizes', { name: '', quantity: 1 })).status, 400);
  await admin('/api/admin/prizes', { name: 'Grand Prize', quantity: 1 });
  await admin('/api/admin/prizes', { name: 'Gift Card', quantity: 2 });
  let state = await (await admin('/api/admin/state')).json();
  const [grand, gift] = state.prizes;
  assert.deepStrictEqual(state.prizes.map((p) => p.name), ['Grand Prize', 'Gift Card']);
  await admin('/api/admin/prizes/move', { id: gift.id, direction: 'up' });
  state = await (await admin('/api/admin/state')).json();
  assert.deepStrictEqual(state.prizes.map((p) => p.name), ['Gift Card', 'Grand Prize']);

  const first = await (await admin('/api/admin/draw', { prizeId: grand.id })).json();
  assert.ok(['21', '22', '23', '25'].includes(first.key) || !['24'].includes(first.key));
  assert.strictEqual((await admin('/api/admin/draw', { prizeId: grand.id })).status, 409);
  assert.strictEqual((await admin('/api/admin/prizes/delete', { id: grand.id })).status, 409);
  assert.strictEqual((await admin('/api/admin/prizes/update', { id: grand.id, name: 'Grand', quantity: 0 })).status, 400);

  // A winner can't win again, and a removed participant is never drawn.
  raffle = await (await admin('/api/admin/raffle')).json();
  assert.ok(!inPool(raffle).includes(first.key));
  assert.ok(!inPool(raffle).includes('24'));

  // Not present: the win is cancelled, they leave the draw, and the prize can be drawn again.
  await admin('/api/admin/winners/void', { id: first.id, removeFromDraw: true });
  raffle = await (await admin('/api/admin/raffle')).json();
  assert.deepStrictEqual(raffle.prizes.find((p) => p.id === grand.id).winners, []);
  assert.ok(!inPool(raffle).includes(first.key));
  const second = await (await admin('/api/admin/draw', { prizeId: grand.id })).json();
  assert.notStrictEqual(second.key, first.key);

  // Cancel win (a mistake): they go straight back in the draw.
  const third = await (await admin('/api/admin/draw', { prizeId: gift.id })).json();
  await admin('/api/admin/winners/void', { id: third.id, removeFromDraw: false });
  raffle = await (await admin('/api/admin/raffle')).json();
  assert.ok(inPool(raffle).includes(third.key));

  const winners = await (await admin('/api/admin/winners.csv')).text();
  assert.match(winners, new RegExp(`Grand Prize,${second.number},`));
  const all = await (await admin('/api/admin/export.csv')).text();
  // Ticket 25 is out of the draw if the random first pick was them and that win was cancelled.
  assert.match(all, /25,Walk In,1999,walk@x\.test,yes,.*,Admin,no,0,(yes|no),/);
  assert.match(all, new RegExp(`\\n${second.number},.*,Grand Prize\\r`));

  await admin('/api/admin/logout', {});
  assert.strictEqual((await admin('/api/admin/state')).status, 401);
  adminToken = await adminLogin();
});

test('scanner accounts: sign in, name on records, disable, reset', async () => {
  const created = await (await admin('/api/admin/scanners', { name: 'Gate Maria', username: 'Maria', pin: '' })).json();
  assert.strictEqual(created.username, 'maria');
  assert.match(created.pin, /^\d{6}$/);
  assert.strictEqual((await admin('/api/admin/scanners', { name: 'gate maria', username: 'other' })).status, 409);
  assert.strictEqual((await admin('/api/admin/scanners', { name: 'Someone', username: 'maria' })).status, 409);
  assert.strictEqual((await admin('/api/admin/scanners', { name: 'Bad Pin', username: 'bad', pin: '12' })).status, 400);

  const staffLogin = login;
  assert.strictEqual((await staffLogin('maria', '000000' === created.pin ? '111111' : '000000')).status, 401);
  const session = await (await staffLogin('MARIA ', created.pin)).json();
  assert.strictEqual(session.name, 'Gate Maria');
  const asMaria = (body) => fetch(BASE + '/api/sync', {
    method: 'POST', headers: { 'x-staff-token': session.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const { epoch, user } = await (await asMaria({})).json();
  assert.strictEqual(user, 'Gate Maria');
  // The device claims another name; the record must show who was signed in.
  const after = await (await asMaria({ epoch, ops: [{ type: 'checkin', number: '77', at: 7700, device: 'Somebody Else' }] })).json();
  assert.strictEqual(after.rows.find((r) => r.key === '77').checked_in_by, 'Gate Maria');

  let state = await (await admin('/api/admin/state')).json();
  const maria = state.scanners.find((s) => s.username === 'maria');
  assert.strictEqual(maria.devices, 1);
  assert.strictEqual(maria.scans, 1);
  assert.ok(!('pin_hash' in maria));

  // Turning an account off signs it out at once, and it can't sign back in.
  await admin('/api/admin/scanners/active', { id: maria.id, active: false });
  assert.strictEqual((await asMaria({})).status, 401);
  const blocked = await staffLogin('maria', created.pin);
  assert.match((await blocked.json()).error, /turned off/);
  await admin('/api/admin/scanners/active', { id: maria.id, active: true });

  // A new PIN replaces the old one.
  const reset = await (await admin('/api/admin/scanners/reset-pin', { id: maria.id, pin: '24680' })).json();
  assert.strictEqual(reset.pin, '24680');
  assert.strictEqual((await staffLogin('maria', created.pin)).status, created.pin === '24680' ? 200 : 401);
  const again = await (await staffLogin('maria', '24680')).json();
  assert.ok(again.token);

  await admin('/api/admin/scanners/delete', { id: maria.id });
  const gone = await fetch(BASE + '/api/sync', { method: 'POST', headers: { 'x-staff-token': again.token }, body: '{}' });
  assert.strictEqual(gone.status, 401);
});

test('admin screens are told about changes the moment they happen', async () => {
  const token = await adminLogin();
  assert.strictEqual((await fetch(BASE + '/api/admin/events?token=wrong')).status, 401);

  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/admin/events?token=${token}`, { signal: controller.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const nextVersion = async () => {
    let text = '';
    while (!/data: (\S+)\n\n/.test(text)) text += decoder.decode((await reader.read()).value);
    return text.match(/data: (\S+)\n\n/)[1];
  };
  const before = await nextVersion();

  const { epoch } = await sync({});
  const started = Date.now();
  await sync({ epoch, ops: [{ type: 'checkin', number: '8801', at: 8801, device: 'A' }] });
  const after = await nextVersion();
  assert.notStrictEqual(after, before);
  assert.ok(Date.now() - started < 1000, 'the change should arrive straight away');
  controller.abort();
});
