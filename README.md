# Ticket Scanner

Scan a raffle ticket QR, confirm the details, and move on. The QR holds only the ticket number (`297` on a ticket printed `000297`). Name and batch are handwritten, so the app reads them from a photo taken at the moment of the scan, and staff correct anything wrong.

## Handwriting reader

Create a file named `.env` in this folder containing your Anthropic API key, then restart the server:

```
ANTHROPIC_API_KEY=your-key-here
```

Keys come from https://console.anthropic.com. The terminal prints `Handwriting reader: on` when it's working.

- It needs internet on the computer running the server. Without it, or without a key, scanning still works and staff type name and batch.
- Each ticket photo with blank details is sent to Anthropic to be read, and it is billed per photo. Photos are not saved by this app.
- The scan never waits for it. The check-in is recorded first, and the fields fill in shortly after. Anything already typed is kept.

## Run it

Needs Node 22.13 or newer. There is nothing to install.

```bash
npm start
```

The terminal prints the address for phones. Connect phones to the same Wi-Fi as this computer, open the address, and accept the certificate warning once.

## Signing in

Everyone uses the one sign-in page with a username and PIN.

- **Admin:** username `admin`, PIN `111226`. This opens the admin page. Change the PIN with `ADMIN_PIN=... npm start`, and do so before putting the app on the internet.
- **Scanners:** the admin makes an account for each person on the admin page's Scanners tab. Signing in with it opens the scanner.

The admin page and raffle screen send anyone not signed in to this page, then back once the admin PIN is entered.

## Before the event

1. Setup > Import CSV with columns for number, name and batch (email optional). Excel and Sheets files must be saved as CSV first.
2. Give each phone a name in Setup, such as Gate 1. It appears on the records.
3. Open `/test-tickets.html` on a laptop and try a phone against it.
4. Setup > Clear all data (tap twice to confirm), then import your real list again if you have one, so test scans are not in your records.

The guest list is optional. Once one is loaded, tickets not on it are refused. With no list, any QR holding only digits is admitted, and other QR codes are refused.

## At the door

- Hold the ticket flat with its top section (above the tear line) filling the on-screen guide: QR in the dashed box on the left, name and batch on the dashed lines on the right.
- Green: admitted and recorded the moment it scans. The card shows the ticket number, and name and batch fill in from the photo with an amber outline to check. Correct anything wrong, add the email, then press Done or scan the next ticket, which saves them automatically.
- Tap a domain to finish an email. If name and batch are already filled, that also finishes the card.
- Wrong ticket scanned: tap Wrong ticket to cancel that check-in, then scan the right one.
- Amber: this ticket was already used. The same fields appear, so scanning a ticket again is also a quick way to fix its details.
- Red: not on the list, or not a raffle QR.
- Damaged QR: type the number on the Scan tab, or search the Guests tab.
- "In, no email" on the Guests tab lists who to follow up with, and Edit on any row changes their details later. Ticket numbers can't be edited, because the QR has to keep matching. Importing the list again replaces edited names and batches.

## Admin and raffle

**Admin page** (`/admin.html`)
- Participants: everyone scanned, with search and filters. Remove someone from the draw (staff, ineligible guests) or add them back, admit someone who wasn't scanned, and export participants or winners as CSV.
- Prizes: add prizes with how many winners each gets, edit them, and set the drawing order. The list shows each prize's winners. **Not present** cancels a win and takes that person out of the draw.

**Scanners** (admin page, Scanners tab)
- Add an account for each person scanning: the name to show on records, a username, and a PIN (leave it blank for a random 6-digit one). The PIN is shown once, so pass it on straight away.
- They sign in with that username and PIN, and every check-in they make is recorded under their name.
- **New PIN**, **Turn off** and **Delete** sign that person out of every device at once. The table shows how many devices each person is signed in on and how many tickets they've scanned.

**Raffle screen** (`/raffle.html`) is for the projector. Open it on the laptop connected to the projector and log in with the admin account.
- Choose the prize, then press **Draw** or the space bar. The reels stop one by one on the winning ticket number, then the name and batch appear.
- **Not present, redraw** cancels the last win for that prize and draws again straight away.
- Keys: space draws, left and right arrows change prize, F goes full screen, M turns sound on or off. The controls fade out when the mouse is still.
- The server picks every winner at random from everyone admitted, not removed, and not already a winner, so nobody wins twice.
- The public screen never shows email addresses.

Clearing all data in Setup also deletes winners. Prizes are kept.

## QR formats it reads

A plain number, `number|name|batch` (also with `,` or `;`), JSON, `Number: 12` style lines, or a web link with `id`, `name` and `batch` parameters.

## Records

Setup > Export gives a CSV of everyone. The live records are in `data/checkins.db`.

If Wi-Fi drops, scanners keep working from their own copy and send their scans when it returns. The top-right pill shows anything not yet sent. Don't reload a phone while it says Offline, because the page can't load without the server. A ticket used on two offline scanners is flagged in the export under `conflicting_scans`.

## Hosting instead of a laptop

Run with `USE_HTTP=1` behind any HTTPS host or tunnel, and set `DATA_DIR` to persistent storage. Always set your own `ADMIN_PIN` when it is reachable from the internet, because this data includes people's emails.

## Tests

```bash
npm test
```
