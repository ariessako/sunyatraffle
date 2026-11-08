// Shared by the browser and the server: reads QR payloads and guest-list CSVs.
(function () {
  const NUMBER_KEYS = new Set(['number', 'no', 'num', 'nr', 'ticket', 'ticketno', 'ticketnum', 'ticketnumber', 'ticketid', 'id', 'code']);
  const NAME_KEYS = new Set(['name', 'fullname', 'attendee', 'guest', 'guestname']);
  const BATCH_KEYS = new Set(['batch', 'batchno', 'batchnumber', 'group', 'cohort']);
  const EMAIL_KEYS = new Set(['email', 'emailaddress', 'mail']);

  const cleanKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

  function fieldOf(key) {
    const k = cleanKey(key);
    if (NUMBER_KEYS.has(k)) return 'number';
    if (NAME_KEYS.has(k)) return 'name';
    if (BATCH_KEYS.has(k)) return 'batch';
    if (EMAIL_KEYS.has(k)) return 'email';
    return null;
  }

  // "#0012" and "12" are the same ticket, so a QR and a guest list can format numbers differently.
  function ticketKey(number) {
    const s = String(number ?? '').trim().replace(/^#/, '').toUpperCase();
    return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
  }

  function fromFields(entries) {
    const out = { number: '', name: '', batch: '' };
    for (const [key, value] of entries) {
      const field = fieldOf(key);
      if (field && field !== 'email' && !out[field]) out[field] = String(value ?? '').trim();
    }
    return out;
  }

  function parseTicket(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { number: '', name: '', batch: '' };

    if (text.startsWith('{')) {
      try {
        const parsed = fromFields(Object.entries(JSON.parse(text)));
        if (parsed.number) return parsed;
      } catch {}
    }

    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        const parsed = fromFields([...url.searchParams.entries()]);
        if (!parsed.number) parsed.number = url.pathname.split('/').filter(Boolean).pop() || text;
        return parsed;
      } catch {}
    }

    const delimiter = ['|', ';', '\t', '\n', ','].find((d) => text.includes(d));
    if (!delimiter) {
      const single = text.match(/^([\w ]+?)\s*[:=]\s*(.+)$/);
      if (single && fieldOf(single[1]) === 'number') return fromFields([[single[1], single[2]]]);
      return { number: text, name: '', batch: '' };
    }

    const parts = text.split(delimiter).map((p) => p.trim()).filter(Boolean);
    const labelled = parts.map((p) => p.match(/^([\w ]+?)\s*[:=]\s*(.+)$/));
    if (labelled.every(Boolean)) {
      const parsed = fromFields(labelled.map((m) => [m[1], m[2]]));
      if (parsed.number) return parsed;
    }

    if (parts.length > 1 && !/\d/.test(parts[0]) && /\d/.test(parts[1])) {
      [parts[0], parts[1]] = [parts[1], parts[0]];
    }
    // A comma inside a name ("Smith, Jo") leaves extra parts: the batch is still last.
    const [number, ...rest] = parts;
    const batch = rest.length > 1 ? rest.pop() : '';
    return { number, name: rest.join(delimiter === ',' ? ', ' : ' '), batch };
  }

  function csvRows(text) {
    const body = text.replace(/^﻿/, '');
    const firstLine = body.split(/\r?\n/, 1)[0];
    const delimiter = [';', '\t', ','].reduce((best, d) =>
      firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');

    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quoted) {
        if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === delimiter) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  // Accepts any column order when there is a header row; otherwise number, name, batch, email.
  function parseGuestCsv(text) {
    const rows = csvRows(text);
    if (!rows.length) return [];
    const hasHeader = rows[0].some((c) => fieldOf(c) === 'number' || fieldOf(c) === 'name');
    const columns = hasHeader ? rows[0].map(fieldOf) : ['number', 'name', 'batch', 'email'];
    const guests = [];
    for (const row of hasHeader ? rows.slice(1) : rows) {
      const guest = { number: '', name: '', batch: '', email: '' };
      row.forEach((value, i) => { if (columns[i]) guest[columns[i]] = value.trim(); });
      if (ticketKey(guest.number)) guests.push(guest);
    }
    return guests;
  }

  const api = { parseTicket, ticketKey, parseGuestCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.TicketParse = api;
})();
