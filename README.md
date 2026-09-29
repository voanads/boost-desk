# Boost Desk

Daily Facebook boost checklist for your agency. Your team logs in with Facebook, and the app reads Ads Manager directly through Meta's official Marketing API — no Supermetrics or other third-party service.

**Each admin has their own workspace.** When someone logs in with Facebook for the first time, their Boost Desk is empty. Tapping **Sync from Meta** loads only the ad accounts and spend that *their* Facebook login can see. Clients, synced days, reports and settings are never shared between admins. (The Telegram bot is shared, so every admin sees the list of groups the bot is in.)

**What it does**

- **Checklist** — every client's spend for the day, pulled from Ads Manager. Live campaigns go to the client whose **Facebook Page** the ad promotes — the same way boost posts match — so a typo in the campaign name doesn't matter. If Meta hides the Page, the campaign name is used instead (`DC Shop | 29` → DC Shop). For live clients, campaigns that start within 30 minutes of each other count as one live (Live 1, Live 2, …). Ticks, live times and notes are saved.
- **Ad accounts** — every ad account you can access: status (with the reason if disabled), balance due, spend limit left, lifetime spend, and today's spend. Tick which accounts are included in the spend sync.
- **Clients** — name, one or more Facebook Pages (spend from any of them counts for that client) and type (live / post / both). Budgets are set by each client, so the app records what was actually spent.
- **Boost posts** — Meta names these automatically (`Post: "…"`), so the app looks up which Facebook Page each boosted post belongs to and gives the spend to the client with that Page name. This works even when one ad account boosts posts for many Pages. For *Post + live* clients, boosted posts go in the post row and named campaigns go in the live rows.
- **Telegram** — the day's report is sent to your group automatically every night (default 21:00), after a fresh sync.
- **Background auto sync** (nothing to tap, nothing shown in the app) — every 5 minutes it checks for **newly created campaigns** and pulls their spend right away; every hour it refreshes today and yesterday; every morning at 05:30 it refreshes the last 30 days, since Meta keeps finalizing late spend. It only runs for admins who have tapped **Sync from Meta** at least once and whose Facebook login is still valid, and it never runs at the same time as a manual sync. Set `AUTO_SYNC=off` to turn it off for everyone.
- **Auto sync control (app owner only)** — on **Team & Telegram**, the owner sees every account that has logged in, and can turn auto sync on or off for each one (or all at once), see when it last ran, and tap **Run now**. The owner can also **Remove** an account: that deletes its clients, synced days and settings, logs it out, and blocks that Facebook account from logging in again (nothing in Facebook or Ads Manager is touched). Removed accounts are listed below with **Restore access**. Other admins don't see this panel. The owner is the admin with the most clients when the feature first starts; set `OWNER_FB_ID` in Railway to choose someone else.
- **Sync from Meta** — one tap pulls and saves the **last 30 days** (or the whole month when you're looking at an older date).
- **Dashboard** — every client's spend for **Today, Yesterday, Last 7 / 30 days, This month, Last month or any custom range**: live vs post spend, number of lives, spend per day, share of total, and a spend-per-day chart. Search by client or Page, filter by type, sort any column, tap a day or client to drill in.

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
2. Lives and boost posts both match automatically by the client's Facebook Page name (then by campaign name). The **Ad account** field is only a fallback, for a client whose Page can't be looked up.
3. **Ad accounts** tab → **Refresh from Meta**, then untick accounts that aren't used for client boosts.
4. **Checklist** → **Sync from Meta**. Anything that didn't match a client is listed under *Spend not matched to a client*.

## Good to know

- **Facebook logins last about 60 days.** The Team tab shows when each login expires, and the Telegram report warns a week before. Just log in again.
- Background syncs and the nightly report use each admin's own login. Days refreshed in the background show **Auto sync** as "last synced by".
- Spend is in each ad account's currency (usually USD). Non-USD accounts show their currency on the Ad accounts tab.
- Meta limits how often apps can call the API. With ~20 ad accounts and hourly sync you're well within limits; if Meta asks you to slow down, the app says so and you can try again a few minutes later.
- Change `LIVE_GAP_MINUTES` if your lives are closer together or further apart than 30 minutes.

## Files

```
server.js            routes: Facebook login, API, pages
src/meta.js          Meta Graph / Marketing API client
src/sync.js          matching campaigns to clients, live grouping, report text
src/jobs.js          background auto sync (new campaigns, hourly, daily) + nightly Telegram report
src/db.js            Postgres tables and queries
src/crypto.js        encrypts Facebook tokens at rest (AES-256-GCM)
src/telegram.js      Telegram sender
public/              login page and the app (plain HTML/CSS/JS)
test/                npm test — checks live grouping on real campaign names
```
