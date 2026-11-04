# SiAP Inbox

Unified inbox backend for SiAP Studio. WhatsApp first, built so Instagram or email can plug in later.

## What v1 does
- Receives WhatsApp messages via Meta webhook (signature checked, retries deduped)
- One conversation per customer, with history
- Reply from the API (blocked outside WhatsApp's 24h window, since only templates are allowed then)
- Notes, tags, assignee, status (open / pending / closed), unread counts
- Delivery status updates (sent, delivered, read)

## Run
    cp .env.example .env   # fill in
    npm install
    npm test
    npm start

Needs Node 22.5+ (uses built-in `node:sqlite`).

## Meta setup
1. developers.facebook.com, create a Business app, add WhatsApp.
2. Webhook callback URL: `https://<your-host>/webhooks/whatsapp`, verify token = `WA_VERIFY_TOKEN`. Subscribe to `messages`.
3. App secret goes in `WA_APP_SECRET`. Use a permanent system-user token for `WA_ACCESS_TOKEN`.

## API (header `Authorization: Bearer $API_TOKEN`)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/conversations?status=&assignee=&tag=&before= | Inbox list, newest first |
| GET | /api/conversations/:id | Messages, notes, tags |
| POST | /api/conversations/:id/messages `{body}` | Send reply |
| POST | /api/conversations/:id/read | Clear unread |
| PATCH | /api/conversations/:id `{status, assignee_id}` | Update |
| POST | /api/conversations/:id/notes `{body}` | Internal note |
| POST/DELETE | /api/conversations/:id/tags | Add or remove tag |

## Not built yet
Media messages (stored as `[image]` placeholders), template sends, agent login, realtime push, other channels, WhatsApp calling. SQLite is fine for a small studio, swap for Postgres if it grows.
