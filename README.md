# Rute Telegram Bot 🌟
### 24/7 Personal Telegram Assistant, Habit Coach & English Tutor

Rute is a lightweight, stateless Telegram assistant powered by **Node.js (ES Modules)**, **grammY**, **Google Gemini 2.5 Flash (`@google/genai`)**, and **Upstash Redis**. Designed for zero-cost deployment on platforms like Render.com or Koyeb.

---

## 🏗️ Architecture & Core Principles

- **Stateless & Serverless Persistence**: All persistent user state (streaks, timestamps, reset flags, and history) is saved in **Upstash Redis** under the key `recovery_tracker`. No local files (`.json`, `.sqlite`, or temporary audio files) are written to disk.
- **Pure In-Memory Audio Handling**: Telegram `.oga`/`.ogg` voice notes are streamed directly into an in-memory buffer, encoded to Base64, and sent to Gemini 2.5 Flash via `inlineData`.
- **Single-Reset-Day Cap**: When a relapse is reported, the streak drops to `0` and a `resetDayToday` flag is set. If further slips occur within the same 24-hour cycle, the bot acknowledges them with grounding techniques without penalizing streak days multiple times.
- **Nightly Branching Logic**: The nightly cron route (`/api/cron/night`) branches based on `resetDayToday`:
  - If `resetDayToday === true`: Sends encouraging words of compassion, does *not* advance the streak, and clears the flag so the next day starts fresh as Day 1.
  - If `resetDayToday === false`: Congratulates the user on a clean day, increments `streakDays`, and updates `bestStreakDays`.
- **Strict User Authorization**: Every Telegram update is checked against `ALLOWED_TELEGRAM_USER_ID`. Unauthorized users are strictly and silently dropped.
- **Secure Cron Triggers**: Internal cron endpoints require the `x-cron-secret` header matching `CRON_SECRET`.

---

## 📋 Table of Contents
1. [Prerequisites & Key Generation](#1-prerequisites--key-generation)
2. [Local Setup & Installation](#2-local-setup--installation)
3. [Upstash Redis Database Setup](#3-upstash-redis-database-setup)
4. [Deployment to Render.com](#4-deployment-to-rendercom)
5. [Registering the Telegram Webhook](#5-registering-the-telegram-webhook)
6. [Automating Schedules with cron-job.org](#6-automating-schedules-with-cron-joborg)
7. [Commands & Interaction Guide](#7-commands--interaction-guide)

---

## 1. Prerequisites & Key Generation

Before deploying Rute, collect the following credentials:

### 1. Telegram Bot Token
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to choose a name and username (e.g. `my_rute_bot`).
3. Copy the HTTP API token generated (e.g. `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).

### 2. Your Telegram User ID
1. In Telegram, search for [@userinfobot](https://t.me/userinfo_bot) or [@getmyid_bot](https://t.me/getmyid_bot).
2. Send `/start`. The bot will reply with your numeric `Id` (e.g. `987654321`).
3. Set this as `ALLOWED_TELEGRAM_USER_ID`. Only this ID will be permitted to interact with Rute.

### 3. Google Gemini API Key
1. Go to [Google AI Studio](https://aistudio.google.com/).
2. Sign in with your Google Account and click **Get API key**.
3. Create a key in a project and copy the value.

### 4. Cron Secret Token
Create a secure random secret for your webhook cron endpoints. For example, in PowerShell or bash:
```bash
# In bash
openssl rand -hex 16

# Or simply generate a random 32-character string
```

---

## 2. Local Setup & Installation

Clone or open the project folder in your terminal:

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

Open `.env` and fill in your values:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_TELEGRAM_USER_ID=your_numeric_user_id
GEMINI_API_KEY=your_gemini_api_key
UPSTASH_REDIS_REST_URL=https://your-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token
CRON_SECRET=your_secure_cron_secret
```

To run locally in development mode:
```bash
npm run dev
```

> **Testing Webhooks Locally**: Use [ngrok](https://ngrok.com/) to tunnel your local port:
> ```bash
> ngrok http 3000
> ```
> Then set your webhook to `https://<ngrok-id>.ngrok-free.app/telegram-webhook`.

---

## 3. Upstash Redis Database Setup

1. Create a free account at [console.upstash.com](https://console.upstash.com/).
2. Click **Create Database**:
   - **Name**: `rute-recovery-tracker`
   - **Type**: Regional (select the region closest to your host, e.g. US East or Europe)
3. Once created, scroll to the **REST API** section on the database details page.
4. Copy the following two values into your `.env`:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

---

## 4. Deployment to Render.com

Render offers a reliable zero-cost web service tier:

1. Push your repository to GitHub (or GitLab).
2. Go to [dashboard.render.com](https://dashboard.render.com/) and click **New +** -> **Web Service**.
3. Connect your repository.
4. Configure the service settings:
   - **Name**: `rute-telegram-bot`
   - **Region**: Choose the region closest to your Upstash Redis database
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Scroll down to **Environment Variables** and add all variables from your `.env`:
   - `PORT`: `10000` (or leave default, Render sets `PORT` automatically)
   - `TELEGRAM_BOT_TOKEN`
   - `ALLOWED_TELEGRAM_USER_ID`
   - `GEMINI_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `CRON_SECRET`
6. Click **Deploy Web Service**. Once built, copy your service's public URL (e.g., `https://rute-telegram-bot.onrender.com`).

---

## 5. Registering the Telegram Webhook

To connect Telegram to your newly deployed bot:

Replace `<TELEGRAM_BOT_TOKEN>` and `<YOUR_RENDER_URL>` in the following URL and paste it into your browser or run it with `curl`:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR_RENDER_URL>/telegram-webhook"
```

You should receive a JSON response:
```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

To verify your webhook status anytime:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

---

## 6. Automating Schedules with cron-job.org

Free-tier services on Render spin down after periods of inactivity. External cron pings not only wake the service, but also trigger Rute's daily coaching interventions.

Create an account at [cron-job.org](https://cron-job.org/) (free) and set up the following 3 jobs:

### Job 1: Morning Focus Check-in
- **Title**: Rute Morning Focus
- **URL**: `https://<YOUR_RENDER_URL>/api/cron/focus`
- **Method**: `POST`
- **Schedule**: Every day at `08:00` (choose your local timezone)
- **Headers**:
  - Name: `x-cron-secret`
  - Value: `<YOUR_CRON_SECRET>`

### Job 2: Evening Wind-Down
- **Title**: Rute Evening Wind-Down
- **URL**: `https://<YOUR_RENDER_URL>/api/cron/wind-down`
- **Method**: `POST`
- **Schedule**: Every day at `21:30` (your local timezone)
- **Headers**:
  - Name: `x-cron-secret`
  - Value: `<YOUR_CRON_SECRET>`

### Job 3: Nightly Recovery & Streak Evaluator
- **Title**: Rute Nightly Check-in
- **URL**: `https://<YOUR_RENDER_URL>/api/cron/night`
- **Method**: `POST`
- **Schedule**: Every day at `23:30` (your local timezone)
- **Headers**:
  - Name: `x-cron-secret`
  - Value: `<YOUR_CRON_SECRET>`

---

## 7. Commands & Interaction Guide

| Action / Trigger | Example | Bot Response |
| :--- | :--- | :--- |
| **Start / Help** | `/start` or `/help` | Welcomes user, introduces Rute, shows current streak and guide. |
| **Report Relapse** | `relapse`, `recaída`, `/relapse` | Enforces single-reset-day cap. Resets streak to 0 (if first today) and guides through immediate emotional regulation. |
| **Check Progress** | `progress`, `status`, `streak` | Displays current streak, best streak, today's status, and last recorded relapse timestamp. |
| **Voice Message** | Native Telegram audio note | Downloads buffer into memory, feeds Base64 to Gemini 2.5 Flash, and replies with habit coaching + English tips. |
| **English Practice** | Any text or voice in English | Rute responds naturally in English, plus provides the `📝 English Coaching:` section with grammar and phrasing corrections. |
| **General Chat** | Any personal reflection or goal | Rute replies contextually with full awareness of your current habit streak. |
