// Raffle screen for the projector. The server picks each winner; this page only animates
// the reels onto the ticket number it was given, so the draw is the same whoever runs it.
const $ = (id) => document.getElementById(id);
const BACKUP_REFRESH_MS = 10000; // Changes are pushed instantly; this only covers a dropped connection.
const MIN_REELS = 6;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let data = { version: '', pool: [], prizes: [] };
let pending = null; // Data that arrived mid-spin, held back so it can't spoil the reveal.
let currentId = null;
let spinning = false;
let holding = false; // Keeps a reveal on screen until the next draw or a change of prize.
let heldId = null; // The winner being kept on screen.
let reels = [];
let tickerKey = '';

// ---- Server ----

const refresh = oneAtATime(refreshNow);

async function refreshNow() {
  if (!AdminSession.loggedIn()) return;
  try {
    const res = await AdminSession.call(`/api/admin/raffle?since=${encodeURIComponent(data.version)}`);
    const next = await res.json();
    if (next.unchanged) return;
    if (spinning) pending = next;
    else apply(next);
  } catch {}
}

function apply(next) {
  data = next;
  // A win cancelled from the admin page must not stay on the big screen.
  if (holding && !data.prizes.some((p) => p.winners.some((w) => w.id === heldId))) {
    holding = false;
    closeModal();
  }
  if (!data.prizes.some((p) => p.id === currentId)) {
    currentId = (data.prizes.find((p) => p.winners.length < p.quantity) || data.prizes[0])?.id ?? null;
  }
  render();
}

const currentPrize = () => data.prizes.find((p) => p.id === currentId) || null;

// ---- Rendering ----

function render() {
  const prize = currentPrize();
  const index = data.prizes.indexOf(prize);
  $('prize-step').textContent = prize ? `Prize ${index + 1} of ${data.prizes.length}` : '';
  $('prize-name').textContent = prize ? prize.name : 'Grand Raffle';
  const people = `${data.pool.length} ${data.pool.length === 1 ? 'participant' : 'participants'} in the draw`;
  $('prize-meta').textContent = prize
    ? `${prize.quantity} ${prize.quantity === 1 ? 'winner' : 'winners'} · ${people}`
    : people;

  const select = $('prize-select');
  select.replaceChildren(...data.prizes.map((p, i) => {
    const option = new Option(`${i + 1}. ${p.name} (${p.winners.length}/${p.quantity})`, p.id);
    option.selected = p.id === currentId;
    return option;
  }));
  if (!data.prizes.length) select.append(new Option('No prizes yet', ''));

  const done = prize && prize.winners.length >= prize.quantity;
  $('draw').disabled = !prize || done || !data.pool.length;
  $('draw').textContent = done ? 'All drawn' : 'Draw';
  $('absent').hidden = !prize?.winners.length;
  $('cancel-win').hidden = !prize?.winners.length;

  renderWinners(prize);
  renderTicker();
  if (!spinning && !holding) showIdle(prize);
  sizeReels();
}

function showIdle(prize) {
  const last = prize?.winners.at(-1);
  const name = $('winner-name');
  name.className = 'winner-name';
  if (last) {
    setReels(ticketLabel(last.number));
    $('winner-label').textContent = prize.winners.length >= prize.quantity ? 'Winner' : 'Latest winner';
    name.textContent = last.name || `Ticket ${ticketLabel(last.number)}`;
    $('winner-batch').textContent = last.batch ? `Batch ${last.batch}` : '';
  } else {
    setReels('');
    $('winner-label').textContent = prize ? 'Ready to draw' : 'Add prizes on the admin page';
    name.textContent = 'Good luck!';
    name.className = 'winner-name blessing';
    $('winner-batch').textContent = '';
  }
}

function renderWinners(prize, newId) {
  const winners = prize?.winners || [];
  $('winners-row').hidden = !winners.length;
  $('winners-list').replaceChildren(...winners.map((w) => {
    const li = document.createElement('li');
    const number = document.createElement('b');
    number.textContent = ticketLabel(w.number);
    li.append(number, w.name || 'Ticket holder');
    if (w.id === newId) li.className = 'new';
    return li;
  }));
}

function renderTicker() {
  const key = data.pool.map((g) => g.key).join(',');
  if (key === tickerKey) return;
  tickerKey = key;
  const track = $('ticker-track');
  const items = data.pool.map((g) => {
    const span = document.createElement('span');
    const number = document.createElement('b');
    number.textContent = ticketLabel(g.number);
    const dot = document.createElement('i');
    dot.textContent = ' ◆';
    span.append(number, [g.name, g.batch && `’${String(g.batch).slice(-2)}`].filter(Boolean).join(' ') || 'Ticket holder', dot);
    return span;
  });
  // Two copies side by side, so the scroll loops without a gap.
  track.replaceChildren(...items, ...items.map((el) => el.cloneNode(true)));
  track.style.setProperty('--ticker-duration', `${Math.max(40, data.pool.length * 2.4)}s`);
  track.parentElement.hidden = !data.pool.length;
}

// ---- Reels ----

function reelCount() {
  const longest = [...data.pool, ...data.prizes.flatMap((p) => p.winners)]
    .reduce((n, g) => Math.max(n, ticketLabel(g.number).length), 0);
  return Math.max(MIN_REELS, longest);
}

function makeCell(char) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.textContent = char;
  return cell;
}

function sizeReels() {
  const count = reelCount();
  if (reels.length !== count) {
    reels = Array.from({ length: count }, () => {
      const reel = document.createElement('div');
      reel.className = 'reel';
      const strip = document.createElement('div');
      strip.className = 'strip';
      strip.append(makeCell('0'));
      reel.append(strip);
      return { reel, strip, char: '0' };
    });
    $('reels').replaceChildren(...reels.map((r) => r.reel));
  }
  // As big as the screen allows, then smaller until the name, winners and ticker all fit.
  // A reel row is about (0.81 × reels + 0.5) cells wide, counting gaps and the lacquer frame.
  const width = Math.min(innerWidth * .92, 1500);
  const byWidth = width / (count * .81 + .5);
  let cell = Math.floor(Math.max(48, Math.min(byWidth, innerHeight * .2)));
  const root = document.documentElement.style;
  root.setProperty('--cell', `${cell}px`);
  while (contentBottom() > innerHeight + .5 && cell > 48) {
    cell -= 6;
    root.setProperty('--cell', `${cell}px`);
  }
}

// The lowest edge of the stage's sections. The decorative rays are left out on purpose.
function contentBottom() {
  return Math.max(...[...document.querySelector('.stage').children]
    .filter((el) => !el.hidden)
    .map((el) => el.getBoundingClientRect().bottom));
}

function padLabel(label) {
  const count = reels.length;
  if (!label) return '0'.repeat(count);
  return /^\d+$/.test(label) ? label.padStart(count, '0') : label.padStart(count, ' ').slice(-count);
}

function setReels(label) {
  [...padLabel(label)].forEach((char, i) => {
    const r = reels[i];
    r.char = char;
    r.strip.style.transition = 'none';
    r.strip.style.transform = 'none';
    r.strip.replaceChildren(makeCell(char));
  });
}

async function spinTo(label) {
  if (ticketLabel(label).length > reels.length) sizeReels();
  const chars = [...padLabel(label)];
  await Promise.all(reels.map(async (r, i) => {
    const final = chars[i];
    const rolls = /\d/.test(final) && !reduceMotion ? 16 + i * 6 : 0;
    const cells = [r.char, ...Array.from({ length: rolls }, () => String(Math.floor(Math.random() * 10))), final];
    r.strip.replaceChildren(...cells.map(makeCell));
    r.strip.style.transition = 'none';
    r.strip.style.transform = 'translateY(0)';
    void r.strip.offsetHeight; // Starts the transition from the top.
    const seconds = reduceMotion ? .3 : 1.7 + i * .48;
    r.strip.style.transition = `transform ${seconds}s cubic-bezier(.12, .62, .16, 1)`;
    r.strip.style.transform = `translateY(calc(var(--cell) * -${cells.length - 1}))`;
    if (rolls) {
      r.strip.classList.add('blur');
      setTimeout(() => r.strip.classList.remove('blur'), seconds * 620);
    }
    await wait(seconds * 1000);
    r.char = final;
    r.strip.style.transition = 'none';
    r.strip.style.transform = 'none';
    r.strip.replaceChildren(makeCell(final));
    r.reel.classList.remove('landed');
    void r.reel.offsetWidth;
    r.reel.classList.add('landed');
    clack();
  }));
}

// Flicks through names under the reels while they spin, slowing as they stop.
function shuffleNames(stopAfterMs) {
  const name = $('winner-name');
  const names = data.pool.map((g) => g.name).filter(Boolean);
  name.className = 'winner-name shuffling';
  $('winner-label').textContent = 'Drawing';
  $('winner-batch').textContent = '';
  if (!names.length || reduceMotion) {
    name.textContent = '…';
    return;
  }
  const begin = performance.now();
  (function next() {
    const elapsed = performance.now() - begin;
    if (elapsed > stopAfterMs) return;
    name.textContent = names[Math.floor(Math.random() * names.length)];
    setTimeout(next, 55 + 230 * (elapsed / stopAfterMs) ** 2);
  })();
}

// ---- Drawing ----

async function drawNow() {
  if (spinning) return;
  closeModal();
  const prize = currentPrize();
  if (!prize) return say('Add prizes on the admin page first.');
  if (prize.winners.length >= prize.quantity) return say(`Every winner for ${prize.name} is drawn. Choose the next prize.`);
  if (!data.pool.length) return say('Nobody is left in the draw.');
  unlockAudio();
  spinning = true;
  holding = false;
  document.body.classList.add('spinning');
  $('draw').disabled = true;
  let winner;
  try {
    winner = await (await AdminSession.call('/api/admin/draw', { prizeId: prize.id })).json();
  } catch (err) {
    finish();
    return say(err.message);
  }
  const spinMs = reduceMotion ? 300 : (1.7 + (reels.length - 1) * .48) * 1000;
  shuffleNames(spinMs - 250);
  await spinTo(ticketLabel(winner.number));
  reveal(winner, prize);
  await wait(400);
  finish(winner.id);
}

function reveal(winner, prize) {
  const name = $('winner-name');
  $('winner-label').textContent = prize.quantity > 1 ? `Congratulations · ${prize.name}` : 'Congratulations';
  name.textContent = winner.name || `Ticket ${ticketLabel(winner.number)}`;
  name.className = 'winner-name';
  void name.offsetWidth;
  name.className = 'winner-name revealed';
  $('winner-batch').textContent = winner.batch ? `Batch ${winner.batch}` : '';
  openModal(winner, prize);
  chime();
  celebrate();
}

// ---- Winner modal ----

let modalTimer = null;

function openModal(winner, prize) {
  $('modal-prize').textContent = prize.name;
  const name = winner.name || `Ticket ${ticketLabel(winner.number)}`;
  $('modal-name').textContent = name;
  $('modal-name').className = `modal-name${name.length > 30 ? ' very-long' : name.length > 18 ? ' long' : ''}`;
  $('modal-batch').textContent = winner.batch ? `Batch ${winner.batch}` : '';
  $('modal-ticket').textContent = ticketLabel(winner.number);
  const modal = $('winner-modal');
  clearTimeout(modalTimer);
  modal.classList.remove('closing', 'open');
  modal.hidden = false;
  void modal.offsetWidth;
  modal.classList.add('open');
  setTimeout(() => confetti($('modal-name')), 450);
}

const modalOpen = () => !$('winner-modal').hidden;

function closeModal() {
  if (!modalOpen()) return;
  const modal = $('winner-modal');
  modal.classList.add('closing');
  modalTimer = setTimeout(() => { modal.hidden = true; modal.classList.remove('open', 'closing'); }, 300);
}

$('winner-modal').addEventListener('click', closeModal);

let celebrateTimer = null;
function celebrate() {
  document.body.classList.add('celebrating');
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => document.body.classList.remove('celebrating'), 3600);
}

function finish(newId) {
  spinning = false;
  document.body.classList.remove('spinning');
  holding = Boolean(newId);
  heldId = newId ?? null;
  if (pending) {
    const next = pending;
    pending = null;
    apply(next);
  } else {
    render();
  }
  if (newId) {
    renderWinners(currentPrize(), newId);
    refresh();
  }
}

let messageTimer = null;
function say(text) {
  $('message').textContent = text;
  wake();
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { $('message').textContent = ''; }, 5000);
}

function choosePrize(step) {
  if (spinning || !data.prizes.length) return;
  const index = data.prizes.findIndex((p) => p.id === currentId);
  const next = data.prizes[Math.min(data.prizes.length - 1, Math.max(0, index + step))];
  currentId = next.id;
  holding = false;
  render();
}

// ---- Sound ----

let audio = null;
let muted = false;
try { muted = localStorage.getItem('raffle-muted') === '1'; } catch {}

function unlockAudio() {
  audio ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
}

function tone(freq, start, length, type = 'sine', volume = .18) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + .01);
  gain.gain.exponentialRampToValueAtTime(.0001, start + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + length);
}

function clack() {
  if (!audio || muted) return;
  tone(180, audio.currentTime, .07, 'triangle', .22);
}

// A soft gong, then a rising pentatonic run (gong, shang, jue, zhi, yu): a Chinese-sounding fanfare.
function chime() {
  if (!audio || muted) return;
  const t = audio.currentTime;
  tone(98, t, 2.6, 'sine', .22);
  tone(196.5, t, 1.8, 'sine', .07);
  [523.25, 587.33, 659.25, 783.99, 880, 1046.5].forEach((f, i) => tone(f, t + .18 + i * .1, 1.3, 'triangle', .1));
}

function renderMute() {
  $('mute').textContent = muted ? 'Sound off' : 'Sound on';
}

// ---- Confetti ----

function confetti(origin = $('winner-name')) {
  if (reduceMotion) return;
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const box = origin.getBoundingClientRect();
  const colors = ['#e8b42f', '#f7dc8a', '#fff4d1', '#c41e24', '#d8433f', '#9f700c'];
  const pieces = Array.from({ length: 220 }, () => ({
    x: box.left + box.width / 2 + (Math.random() - .5) * box.width * .6,
    y: box.top + box.height / 2,
    vx: (Math.random() - .5) * 16,
    vy: -Math.random() * 13 - 4,
    w: 6 + Math.random() * 7,
    h: 3 + Math.random() * 5,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - .5) * .3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = (now - start) / 1000;
    // Clear the whole canvas, not just the window: it may have been resized mid-celebration.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (t > 4.5) return;
    ctx.globalAlpha = t > 3 ? Math.max(0, 1 - (t - 3) / 1.5) : 1;
    for (const p of pieces) {
      p.vy += .28;
      p.vx *= .985;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.angle * 2)));
      ctx.restore();
    }
    requestAnimationFrame(frame);
  })(start);
}

// ---- Controls ----

let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$('controls').contains(document.activeElement) || document.activeElement === document.body) {
      document.body.classList.add('idle');
    }
  }, 3000);
}
['mousemove', 'pointerdown', 'touchstart'].forEach((type) => document.addEventListener(type, wake, { passive: true }));

$('draw').addEventListener('click', (e) => { e.currentTarget.blur(); drawNow(); });
$('prev').addEventListener('click', (e) => { e.currentTarget.blur(); choosePrize(-1); });
$('next').addEventListener('click', (e) => { e.currentTarget.blur(); choosePrize(1); });
$('prize-select').addEventListener('change', (e) => {
  currentId = Number(e.target.value);
  holding = false;
  e.target.blur();
  render();
});
$('mute').addEventListener('click', (e) => {
  e.currentTarget.blur();
  muted = !muted;
  try { localStorage.setItem('raffle-muted', muted ? '1' : '0'); } catch {}
  renderMute();
});
$('fullscreen').addEventListener('click', (e) => { e.currentTarget.blur(); toggleFullscreen(); });
// Cancel win: a mistake or a re-do. The person goes back in the draw and nothing is redrawn.
confirmTap($('cancel-win'), 'Tap again: cancel win, back in draw', () => cancelLastWin({ removeFromDraw: false, redraw: false }));
// Not present: they can't claim it, so they leave the draw and the prize is drawn again.
confirmTap($('absent'), 'Tap again: remove them and redraw', () => cancelLastWin({ removeFromDraw: true, redraw: true }));

async function cancelLastWin({ removeFromDraw, redraw }) {
  const prize = currentPrize();
  const last = prize?.winners.at(-1);
  if (!last || spinning) return;
  closeModal();
  try {
    await AdminSession.call('/api/admin/winners/void', { id: last.id, removeFromDraw });
    holding = false;
    const res = await AdminSession.call('/api/admin/raffle');
    apply(await res.json());
    if (redraw) await drawNow();
    else say(`${last.name || 'The winner'}'s win is cancelled and they're back in the draw.`);
  } catch (err) {
    say(err.message);
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (!$('login').hidden || ['INPUT', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
  // While the winner card is up, the first key press only closes it.
  if (modalOpen()) {
    if ([' ', 'Enter', 'Escape'].includes(e.key)) { e.preventDefault(); closeModal(); }
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); drawNow(); }
  else if (e.key === 'ArrowLeft') choosePrize(-1);
  else if (e.key === 'ArrowRight') choosePrize(1);
  else if (e.key.toLowerCase() === 'f') toggleFullscreen();
  else if (e.key.toLowerCase() === 'm') $('mute').click();
});

addEventListener('resize', () => sizeReels());

renderMute();
sizeReels();
setReels('');
wake();
AdminSession.start(() => {
  refresh();
  keepLive(refresh, BACKUP_REFRESH_MS);
});
