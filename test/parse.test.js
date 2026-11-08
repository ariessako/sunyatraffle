const test = require('node:test');
const assert = require('node:assert');
const { parseTicket, ticketKey, parseGuestCsv } = require('../public/parse.js');

const full = { number: '12', name: 'Jo Lee', batch: 'B' };

test('reads every QR format the tickets might use', () => {
  assert.deepStrictEqual(parseTicket('12'), { number: '12', name: '', batch: '' });
  assert.deepStrictEqual(parseTicket('12|Jo Lee|B'), full);
  assert.deepStrictEqual(parseTicket('12,Jo Lee,B'), full);
  assert.deepStrictEqual(parseTicket('Jo Lee|12|B'), full);
  assert.deepStrictEqual(parseTicket('{"ticket":"12","name":"Jo Lee","batch":"B"}'), full);
  assert.deepStrictEqual(parseTicket('Number: 12\nName: Jo Lee\nBatch: B'), full);
  assert.deepStrictEqual(parseTicket('https://x.test/t?id=12&name=Jo%20Lee&batch=B'), full);
  assert.strictEqual(parseTicket('https://x.test/tickets/12').number, '12');
  assert.deepStrictEqual(parseTicket('12,Lee, Jo,B'), { number: '12', name: 'Lee, Jo', batch: 'B' });
});

test('ticket numbers match regardless of formatting', () => {
  assert.strictEqual(ticketKey('#0012'), ticketKey('12'));
  assert.strictEqual(ticketKey(' ab-1 '), 'AB-1');
  assert.strictEqual(ticketKey('000'), '0');
});

test('reads guest lists with any column order, delimiter or Excel BOM', () => {
  const expected = [{ number: '12', name: 'Lee, Jo', batch: 'B', email: 'jo@x.test' }];
  assert.deepStrictEqual(parseGuestCsv('﻿Name,Batch,Ticket No,Email\r\n"Lee, Jo",B,12,jo@x.test\r\n'), expected);
  assert.deepStrictEqual(parseGuestCsv('Number;Name;Batch;Email\n12;Lee, Jo;B;jo@x.test'), expected);
  assert.deepStrictEqual(parseGuestCsv('12,"Lee, Jo",B,jo@x.test'), expected);
  assert.deepStrictEqual(parseGuestCsv('number,name\n,No Number\n'), []);
});
