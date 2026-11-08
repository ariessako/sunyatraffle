// Sign-in and API calls shared by the admin page and the raffle screen.
// Signing in happens on the one sign-in page (/), which sends the admin back here.
const AdminSession = (() => {
  const STORE = 'ticket-scanner-admin';
  let token = '';
  try { token = localStorage.getItem(STORE) || ''; } catch {}
  let source = null;

  // Off to the sign-in page, which returns here once the admin PIN is entered.
  function signIn() {
    token = '';
    source?.close();
    try { localStorage.removeItem(STORE); } catch {}
    const page = location.pathname.split('/').pop() || 'admin.html';
    location.replace(`/?next=${encodeURIComponent(page)}`);
  }

  async function call(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-admin-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      signIn();
      throw new Error('Please sign in again.');
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    return res;
  }

  async function download(path, filename) {
    const blob = await (await call(path)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function start(ready) {
    if (token) ready();
    else signIn();
  }

  // Calls onChange whenever the server reports a change. EventSource reconnects by itself
  // after a Wi-Fi blip or a server restart.
  function subscribe(onChange) {
    source?.close();
    if (!token) return;
    source = new EventSource(`/api/admin/events?token=${encodeURIComponent(token)}`);
    source.onmessage = onChange;
  }

  async function logout() {
    try { await call('/api/admin/logout', {}); } catch {}
    try { localStorage.removeItem(STORE); } catch {}
    location.replace('/');
  }

  return { call, download, start, logout, subscribe, loggedIn: () => Boolean(token) };
})();

// The QR holds "297" where the ticket prints "000297". Show what's on the paper.
const ticketLabel = (number) => (/^\d+$/.test(number) ? String(number).padStart(6, '0') : String(number));

// Runs fn one call at a time; calls made meanwhile become one more run afterwards.
// This stops an older answer from the server landing after a newer one.
function oneAtATime(fn) {
  let running = false;
  let again = false;
  return async function run() {
    if (running) { again = true; return; }
    running = true;
    try { await fn(); } finally {
      running = false;
      if (again) { again = false; run(); }
    }
  };
}

// Keeps a page current: pushed changes, a slow backup poll, and a catch-up whenever the
// page comes back into view (browsers pause timers on hidden pages).
function keepLive(refresh, backupMs) {
  AdminSession.subscribe(refresh);
  if (keepLive.started) return;
  keepLive.started = true;
  setInterval(refresh, backupMs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  addEventListener('online', refresh);
  addEventListener('focus', refresh);
}

// Two taps for anything that can't be undone. The second tap must come within 4 seconds.
function confirmTap(button, armedLabel, action) {
  const label = button.textContent;
  let timer = null;
  button.addEventListener('click', async () => {
    if (!timer) {
      button.textContent = armedLabel;
      button.classList.add('armed');
      timer = setTimeout(reset, 4000);
      return;
    }
    reset();
    await action();
  });
  function reset() {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove('armed');
  }
}
