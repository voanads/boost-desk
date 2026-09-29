# Boost Desk

Daily Facebook boost checklist for your agency. Your team logs in with Facebook, and the app reads Ads Manager directly through Meta's official Marketing API — no Supermetrics or other third-party service.

**What it does**

- **Checklist** — every client's spend for the day, pulled from Ads Manager. Campaigns named `Page name | day` (e.g. `DC Shop | 29`) go to that client. For live clients, campaigns that start within 30 minutes of each other count as one live (Live 1, Live 2, …). Cards turn red when a client goes over their daily budget. Ticks, live times and notes are saved.
- **Ad accounts** — every ad account you can access: status (with the reason if disabled), balance due, spend limit left, lifetime spend, and today's spend. Tick which accounts are included in the spend sync.
- **Clients** — name, one or more Facebook Pages (spend from any of them counts for that client), type (live / post / both), daily budget and usual lives per day.
- **Boost posts** — Meta names these automatically (`Post: "…"`), so the app looks up which Facebook Page each boosted post belongs to and gives the spend to the client with that Page name. This works even when one ad account boosts posts for many Pages. For *Post + live* clients, boosted posts go in the post row and named campaigns go in the live rows.
- **Telegram** — the day's report is sent to your group automatically every night (default 21:00), after a fresh sync.
- **Past days** — on first login the app fills in the whole current month. **Sync whole month** re-reads every day of the month you're viewing (use it after adding a new client). Each morning, auto-sync also re-checks yesterday, since Meta keeps finalizing late-night spend.
- **Auto sync** — switch it on the Checklist page: Off, every 15 min, 30 min, 1 h, 2 h or 4 h (between 08:00 and 23:59). An open Checklist refreshes itself every 2 minutes to show the new numbers.
- **Dashboard** — every client's spend for a **day** or a **month**: live vs post spend, number of lives, planned budget, over/under, and a spend-per-day chart. Search by client or Page, filter by type, sort any column, tap a day or client to drill in.

The app only asks for `ads_read` (read-only) and `business_management`. It never changes your ads.

---

## 1. Create the Meta app (one time, ~10 minutes)

1. Go to **developers.facebook.com → My Apps → Create app**.
2. Choose the use case for **Marketing API / managing ads** (app type **Business**) and connect it to your Business portfolio.
3. Add the product **Facebook Login for Business**.
   - In **Settings**, add this to **Valid OAuth Redirect URIs**:
     `https://YOUR-DOMAIN/auth/facebook/callback`
   - In **Configurations → Create configuration**: choose **User access token**, and pick the permissions **ads_read** and **business_management**. Copy the **Configuration ID** into `FB_CONFIG_ID`.
   - (If your app uses classic **Facebook Login** instead, leave `FB_CONFIG_ID` empty — the app then asks for the scopes directly.)
4. **App settings → Basic**: copy **App ID** → `FB_APP_ID` and **App secret** → `FB_APP_SECRET`. Add your domain to **App domains**.
5. **App roles → Roles**: add each team member as **Tester** (or Developer). They accept the invite at developers.facebook.com/requests.

> While the app stays in **Development mode**, only people with a role in the app can log in. That's what you want for you and your team — no App Review needed. Each person sees the ad accounts their own Facebook account has access to.

## 2. Create the Telegram bot (optional)

1. In Telegram, message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your team group and send any message in the group.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` (starts with `-100`) into `TELEGRAM_CHAT_ID`.

## 3. Deploy on Railway

1. Push this folder to a new GitHub repo, then in Railway: **New Project → Deploy from GitHub repo**.
2. In the same project: **New → Database → PostgreSQL**. Railway adds `DATABASE_URL` to your app (use a reference variable `${{Postgres.DATABASE_URL}}` if it doesn't).
3. **Settings → Networking → Generate domain**. Put that URL in `BASE_URL` and in the Meta redirect URI from step 1.
4. **Variables**: add everything from `.env.example`. Generate the two secrets with `openssl rand -hex 32` (run it twice).
5. Deploy. Tables are created automatically on first start.
6. Open the URL → **Continue with Facebook**. Your ad accounts load on the first login.

Run locally instead: `cp .env.example .env`, fill it in, then `npm install` and `node --env-file=.env server.js` (Node 20+). Use `BASE_URL=http://localhost:3000` and add `http://localhost:3000/auth/facebook/callback` as a redirect URI.

## 4. First use

1. **Clients** tab → add each client and their **Facebook Pages** (`DC Shop`, `CosMe`, `LR Shop`…). A client with two or three Pages gets all of them listed. After a sync, the Page picker suggests every Page name Meta reported. Pages that don't belong to any client show up on the Checklist with **New client** and **Add to client** buttons.
2. Boost posts match automatically by the client's Facebook Page name. The **Ad account** field is only a fallback, for a client whose Page can't be looked up.
3. **Ad accounts** tab → **Refresh from Meta**, then untick accounts that aren't used for client boosts.
4. **Checklist** → **Sync from Meta**. Anything that didn't match a client is listed under *Spend not matched to a client*.

## Good to know

- **Facebook logins last about 60 days.** The Team tab shows when each login expires, and the Telegram report warns a week before. Just log in again.
- Scheduled syncs and the nightly report use the **most recent login's** access.
- Spend is in each ad account's currency (usually USD). Non-USD accounts show their currency on the Ad accounts tab.
- Meta limits how often apps can call the API. With ~20 ad accounts and hourly sync you're well within limits; if Meta asks you to slow down, the app says so and you can try again a few minutes later.
- Change `LIVE_GAP_MINUTES` if your lives are closer together or further apart than 30 minutes.

## Files

```
server.js            routes: Facebook login, API, pages
src/meta.js          Meta Graph / Marketing API client
src/sync.js          matching campaigns to clients, live grouping, report text
src/jobs.js          hourly auto-sync + nightly Telegram report
src/db.js            Postgres tables and queries
src/crypto.js        encrypts Facebook tokens at rest (AES-256-GCM)
src/telegram.js      Telegram sender
public/              login page and the app (plain HTML/CSS/JS)
test/                npm test — checks live grouping on real campaign names
```
