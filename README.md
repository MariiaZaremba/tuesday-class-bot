# Tuesday Class Telegram Bot

MVP for weekly Tuesday fitness classes:
- Browse upcoming classes
- Capacity limit (default 8)
- Stripe Checkout payment (default $15)
- Booking confirmation in Telegram
- My Classes / attendance history
- Admin roster + one-tap check-in
- Admin command to create the next 8 Tuesday 7:00 PM classes

## 1. Supabase
Create a Supabase project, open SQL Editor, and run `schema.sql`.
Copy:
- Project URL → `SUPABASE_URL`
- Service role key → `SUPABASE_SERVICE_ROLE_KEY`

## 2. Telegram
Create a bot with BotFather and add:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` (without @)
- your numeric Telegram user ID → `ADMIN_TELEGRAM_ID`
- any long random string → `TELEGRAM_WEBHOOK_SECRET`

## 3. Stripe
Create/use a Stripe account and add:
- `STRIPE_SECRET_KEY`
- later, after deploying, create a webhook endpoint at `https://YOUR-PROJECT.vercel.app/api/stripe-webhook`
- listen for `checkout.session.completed` and `checkout.session.expired`
- copy the signing secret → `STRIPE_WEBHOOK_SECRET`

## 4. Vercel
Deploy this folder to Vercel and set all variables from `.env.example`.
Set `APP_URL` to the production Vercel URL.

After deployment visit:
`https://YOUR-PROJECT.vercel.app/api/setup?key=YOUR_ADMIN_TELEGRAM_ID`

This registers the Telegram webhook.

## 5. Create classes
In Telegram, send `/admin`, then tap **Add next 8 Tuesdays**.
The bot creates classes for 7:00 PM America/Chicago with the configured price/capacity.

## Client flow
`/start` → Book a Class → choose Tuesday → Book & Pay → Stripe → Telegram confirmation.

## Admin flow
`/admin` → choose class → tap client name to mark attendance.
