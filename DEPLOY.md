# Deployment Guide — GHL Setter Bot

## Step 1: Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Name it: `Kimberly Setter Bot`
4. Username: `kimberlysetterbot` (or any available name ending in `bot`)
5. BotFather gives you a token — save it as `TELEGRAM_BOT_TOKEN`
6. Start a chat with your new bot (search for it, hit Start)
7. Go to `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
8. Send any message to your bot, then refresh that URL
9. Find `"chat":{"id":` in the response — that number is your `TELEGRAM_CHAT_ID`

## Step 2: Deploy to Railway

1. Go to **railway.app** and sign up (GitHub login recommended)
2. Click **New Project → Deploy from GitHub repo**
3. Push this code to a GitHub repo first (or use Railway's CLI)
4. Add these environment variables in Railway dashboard → Variables:
   - `GHL_API_KEY`
   - `GHL_LOCATION_ID`
   - `CLAUDE_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Railway auto-deploys. Copy your Railway URL (e.g. `https://ghl-setter-bot.railway.app`)

## Step 3: Set Telegram Webhook

Run this in your browser (replace values):
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR_RAILWAY_URL>/telegram/webhook
```

You should see: `{"ok":true,"result":true}`

## Step 4: Configure GHL Webhook

1. GHL → Settings → Integrations → Webhooks
2. Click **Add Webhook**
3. URL: `https://<YOUR_RAILWAY_URL>/webhook/inbound`
4. Events: check **Inbound Message**
5. Save

## Step 5: Test

1. Send a test DM to Naomi's GHL inbox from a test contact
2. Within 30 seconds you should get a Telegram notification with the draft
3. Tap Approve — verify the message appears in GHL

## Changing Active Hours

In `server.js`, line with `DIGEST_HOURS_CT`:
```js
const DIGEST_HOURS_CT = [9, 13, 17, 20]; // 9am, 1pm, 5pm, 8pm CT
```
Change any of these numbers to adjust when digests fire.

Quiet hours (no notifications):
```js
return hour >= 22 || hour < 9; // 10pm–9am CT
```
Change 22 and 9 to adjust.
