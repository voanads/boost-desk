# Backups and secret rotation

## Backups
- Every night at 03:20 (Asia/Phnom_Penh) Boost Desk saves every database table to one file,
  `boost-desk-backup-YYYY-MM-DD.json.gz`, and sends it to the owner's private Telegram chat
  (the chat turned on with `/alerts CODE` on Admin → Health).
- Admin → Settings → **Database backup**: *Back up now* (sends to Telegram) and *Download*.
- If the file would be over 45 MB, `raw_rows` (raw Meta rows, which a sync downloads again) is left out.
- Facebook logins and API keys stay encrypted inside the file — restoring needs the same `ENCRYPTION_KEY`.
- Keep the files private: they contain clients, invoices and settings.

### Restore
1. Stop the app (or point at a new empty database).
2. Start the app once against the new database so it creates the tables (or skip if they already exist).
3. Run: `DATABASE_URL=postgres://… node scripts/restore.js boost-desk-backup-2026-10-23.json.gz`
   It replaces each table's rows with the backup in one transaction (all or nothing) and resets id counters.

## Changing secrets (after a leak)
Admin → Settings → **Security · change secrets** has the checklist. New random values are made in the browser
and pasted straight into Railway → Variables — never into chat.
- `ENCRYPTION_KEY`: set `ENCRYPTION_KEY_OLD` to the current value, then a new `ENCRYPTION_KEY`. On start the app
  re-encrypts every stored login and API key; when the card shows 0 left on the old key, delete `ENCRYPTION_KEY_OLD`.
