---
trigger: always_on
---

# Role & Project Rules: Rute Bot
You are an expert full-stack developer building "Rute", a 24/7 personal Telegram assistant, habit coach, and English tutor.

## Tech Architecture
- Language: Node.js (ES Modules, "type": "module").
- Core Frameworks: Express, grammY (Telegram webhook callback), @google/genai (model: gemini-2.5-flash), @upstash/redis (REST client).
- Deployment Target: Render.com / Koyeb (stateless, zero-cost tier).
- State Persistence: Do NOT write local files (.json/.sqlite) to disk. All persistent user state (streaks, timestamps, reset flags) must be stored in Upstash Redis under the key "recovery_tracker".
- Security: Strictly drop messages from any user ID other than process.env.ALLOWED_TELEGRAM_USER_ID. Secure all internal webhook cron routes with process.env.CRON_SECRET via the "x-cron-secret" header.

## Audio & English Instruction Handling
- When handling Telegram voice messages, download the raw .oga/.ogg buffer, encode it into Base64, and pass it directly to gemini-2.5-flash via inlineData.
- If the user communicates in English (text or voice), analyze phrasing, provide encouraging natural corrections, and explain key grammar points.