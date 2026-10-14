---
description: 
---

Generate the complete codebase for the "Rute" Telegram bot project following our architectural rules:

1. package.json:
   - Configure ES Modules ("type": "module").
   - Include scripts ("start": "node src/index.js", "dev": "node --watch src/index.js").
   - Add dependencies: express, grammy, @google/genai, @upstash/redis, dotenv.

2. .env.example:
   - Document PORT, TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_USER_ID, GEMINI_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and CRON_SECRET.

3. src/index.js:
   - Express server listening on process.env.PORT.
   - GramMY webhook mount on /telegram-webhook.
   - Authorization middleware checking ALLOWED_TELEGRAM_USER_ID.
   - Upstash Redis state manager for recovery_tracker: { streakDays, bestStreakDays, lastRelapseAt, resetDayToday, history }.
   - Handlers for text triggers ("relapse", "progress") and native Telegram voice messages sent to Gemini 2.5 Flash with Base64 audio.
   - Protected cron routes (/api/cron/focus, /api/cron/night, /api/cron/wind-down) validating header x-cron-secret.

4. README.md:
   - Step-by-step instructions to obtain keys, create the Upstash database, deploy to Render.com, set the Telegram webhook URL, and configure cron-job.org schedules.