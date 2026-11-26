# Backups and secret rotation

## Backups
- Every night at 03:20 (Asia/Phnom_Penh) Boost Desk saves every database table to one file,
  `boost-desk-backup-YYYY-MM-DD.json.gz` (`.json.gz.enc` when `BACKUP_KEY` is set).
- **Off-site storage (recommended):** set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`,
  `BACKUP_S3_SECRET_KEY` (and `BACKUP_S3_REGION`, `auto` for Cloudflare R2). The file is uploaded to
  `<bucket>/boost-desk/…`, and the owner's Telegram only gets a short "backup OK" note (or a warning if it failed).
  Set `BACKUP_TELEGRAM_FILE=on` to send the file to Telegram as well. Turn on a lifecycle rule in the bucket
  (e.g. delete after 60 days) so old backups don't pile up.
- **Without off-site storage** the file is sent to the owner's private Telegram chat
  (the chat turned on with `/alerts CODE` on Admin → Health), as before.
- **Encryption:** `BACKUP_KEY` (64 hex characters, `openssl rand -hex 32`) encrypts the whole file with AES-256-GCM.
  Keep a copy of the key outside Railway (a password manager): without it, a backup cannot be opened.
- Only one copy of the app makes the backup, even while two copies run during a deploy.
- Admin → Settings → **Database backup**: *Back up now* (sends to Telegram) and *Download*.
- Without off-site storage, if the file would be over 45 MB, `raw_rows` (raw Meta rows, which a sync downloads again) is left out.
- Facebook logins and API keys stay encrypted inside the file — restoring needs the same `ENCRYPTION_KEY`.
- Keep the files private: they contain clients, invoices and settings.

### Restore
1. Stop the app (or point at a new empty database).
2. Start the app once against the new database so it creates the tables (or skip if they already exist).
3. Run: `DATABASE_URL=postgres://… node scripts/restore.js boost-desk-backup-2026-10-23.json.gz`
   For an encrypted file add the key: `BACKUP_KEY=… node scripts/restore.js boost-desk-backup-2026-10-23.json.gz.enc`
   It replaces each table's rows with the backup in one transaction (all or nothing) and resets id counters.

## Changing secrets (after a leak)
Admin → Settings → **Security · change secrets** has the checklist. New random values are made in the browser
and pasted straight into Railway → Variables — never into chat.
- `ENCRYPTION_KEY`: set `ENCRYPTION_KEY_OLD` to the current value, then a new `ENCRYPTION_KEY`. On start the app
  re-encrypts every stored login and API key; when the card shows 0 left on the old key, delete `ENCRYPTION_KEY_OLD`.
