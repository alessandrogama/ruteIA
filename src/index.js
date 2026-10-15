import express from 'express';
import { Bot, webhookCallback } from 'grammy';
import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ==========================================
// 1. Strict Environment Validation
// ==========================================
const REQUIRED_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_TELEGRAM_USER_ID',
  'GEMINI_API_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'CRON_SECRET'
];

function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter((key) => {
    const value = process.env[key];
    return !value || value.trim() === '';
  });

  if (missing.length > 0) {
    console.error('====================================================');
    console.error('FATAL ERROR: Missing required environment variables:');
    missing.forEach((v) => console.error(` - ${v}`));
    console.error('Please configure them in your .env or platform settings.');
    console.error('====================================================');
    process.exit(1);
  }
}

validateEnvironment();

const PORT = process.env.PORT || 3000;
const ALLOWED_USER_ID = process.env.ALLOWED_TELEGRAM_USER_ID.trim();
const CRON_SECRET = process.env.CRON_SECRET.trim();
const REDIS_TRACKER_KEY = 'recovery_tracker';

// ==========================================
// 2. Client Initialization
// ==========================================
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// ==========================================
// 3. Upstash Redis State Manager
// ==========================================
const defaultRecoveryState = {
  streakDays: 0,
  bestStreakDays: 0,
  lastRelapseAt: null,
  resetDayToday: false,
  history: []
};

/**
 * Fetch persistent state from Upstash Redis
 */
async function getRecoveryState() {
  try {
    const raw = await redis.get(REDIS_TRACKER_KEY);
    if (!raw) return { ...defaultRecoveryState };

    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      streakDays: typeof parsed.streakDays === 'number' ? parsed.streakDays : 0,
      bestStreakDays: typeof parsed.bestStreakDays === 'number' ? parsed.bestStreakDays : 0,
      lastRelapseAt: parsed.lastRelapseAt || null,
      resetDayToday: Boolean(parsed.resetDayToday),
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch (error) {
    console.error('[Redis] Error fetching state:', error);
    return { ...defaultRecoveryState };
  }
}

/**
 * Persist state to Upstash Redis (no disk access)
 */
async function saveRecoveryState(state) {
  try {
    // Keep history bounded to last 100 entries to prevent unbounded growth
    if (state.history.length > 100) {
      state.history = state.history.slice(-100);
    }
    await redis.set(REDIS_TRACKER_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('[Redis] Error saving state:', error);
    throw error;
  }
}

/**
 * Record a relapse with single-reset-day cap enforcement
 */
async function recordRelapse() {
  const state = await getRecoveryState();
  const now = new Date().toISOString();

  // If already marked as reset today, enforce single-reset-day cap
  if (state.resetDayToday) {
    state.history.push({
      type: 'relapse_repeat',
      timestamp: now,
      note: 'Additional slip reported during existing reset day (streak remains 0)'
    });
    await saveRecoveryState(state);
    return { alreadyReset: true, state };
  }

  // First relapse of the day: reset streak to 0 and flag resetDayToday
  const streakBefore = state.streakDays;
  state.streakDays = 0;
  state.resetDayToday = true;
  state.lastRelapseAt = now;
  state.history.push({
    type: 'relapse',
    timestamp: now,
    streakBefore
  });

  await saveRecoveryState(state);
  return { alreadyReset: false, streakBefore, state };
}

/**
 * Process nightly cron logic:
 * - If resetDayToday is true: send encouragement, do not advance streak, clear resetDayToday flag for tomorrow.
 * - If resetDayToday is false: advance streakDays by 1, update bestStreakDays, record clean day.
 */
async function handleNightlyCronEvaluation() {
  const state = await getRecoveryState();
  const now = new Date().toISOString();

  if (state.resetDayToday) {
    // Branch A: Reset day was flagged today.
    // Do NOT increment streak. Clear the flag for tomorrow's clean slate.
    state.resetDayToday = false;
    state.history.push({
      type: 'reset_day_close',
      timestamp: now,
      note: 'Reset day completed. Ready to start Day 1 clean tomorrow.'
    });
    await saveRecoveryState(state);
    return { wasResetDay: true, state };
  }

  // Branch B: Clean day completed successfully!
  state.streakDays += 1;
  if (state.streakDays > state.bestStreakDays) {
    state.bestStreakDays = state.streakDays;
  }
  state.history.push({
    type: 'clean_day',
    timestamp: now,
    streakDays: state.streakDays
  });

  await saveRecoveryState(state);
  return {
    wasResetDay: false,
    streakDays: state.streakDays,
    bestStreakDays: state.bestStreakDays,
    state
  };
}

// ==========================================
// 4. Gemini AI System Instruction & Persona
// ==========================================
const RUTE_SYSTEM_PROMPT = `You are "Rute", a 24/7 personal Telegram assistant, habit coach, and English tutor.

Core Persona & Rules:
1. Tone: Empathetic, disciplined, grounded, articulate, and motivating. You are both a stoic recovery coach and an encouraging English tutor.
2. Habit Recovery:
   - Understand the neurobiology of habits, dopamine regulation, urge surfing, and friction design.
   - Treat relapses without shame or moral judgment. Treat them as data to identify triggers and strengthen systems.
   - Always encourage continuous forward momentum.
3. English Tutor & Correction Protocol:
   - Whenever the user communicates in English (via voice or text), analyze their phrasing and grammar.
   - In addition to your natural conversational response, include a distinct, encouraging coaching section:
     "📝 **English Coaching:**"
     - Highlight any unnatural phrasing or grammatical errors with gentle, clear corrections.
     - Explain the rule briefly (e.g., preposition choice, collocations, tense consistency).
     - Provide a natural native-speaker alternative.
   - If their English is completely natural and accurate, give a quick praise (e.g., "🎯 Perfect natural phrasing!").
4. Language Adaptability:
   - If the user writes or speaks in Portuguese, respond in Portuguese naturally and warmly.
   - If the user writes or speaks in English, reply in English and provide the English Coaching section.
5. Message Length:
   - Keep answers punchy, well-structured, and easy to read on a mobile Telegram screen.
   - Use bold headers, bullet points, and brief paragraphs.`;

/**
 * Safely send Telegram messages with markdown fallback
 */
async function sendSafeMessage(chatId, text, extra = {}) {
  try {
    return await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    console.warn(`[Telegram] Markdown send error, falling back to plain text: ${err.message}`);
    return await bot.api.sendMessage(chatId, text, extra);
  }
}

async function replySafe(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    console.warn(`[Telegram] Markdown reply error, falling back to plain text: ${err.message}`);
    return await ctx.reply(text, extra);
  }
}

// ==========================================
// 5. Telegram Bot Middleware & Handlers
// ==========================================

// Reaction constants
const AFFECTION_EMOJIS = ['❤️', '💖', '🥰', '😍'];
const REACTION_REPLY_EMOJIS = ['❤️', '🔥', '✨', '🙏', '🙌', '😊'];
const AFFECTION_TEXT_RESPONSES = [
  "Fico feliz pelo seu carinho! Seguimos firmes e focados hoje! 🙏✨",
  "Tamo junto, Alessandro! Vamos manter a consistência! 💪",
  "Valeu pela força! Um passo de cada vez. ❤️",
  "Obrigada pelo carinho! Cada dia conta na nossa jornada. 🔥✨",
  "Tamo junto! Foco total nos seus objetivos hoje! 🙌"
];

// Security Middleware: Strictly drop updates from unauthorized user IDs
bot.use(async (ctx, next) => {
  const fromId = (ctx.from?.id || ctx.messageReaction?.user?.id)?.toString();
  if (!fromId || fromId !== ALLOWED_USER_ID) {
    console.warn(`[Security] Dropping update from unauthorized user ID: ${fromId || 'unknown'}`);
    return; // Drop silently
  }
  await next();
});

// Handler para Reações Nativas (message_reaction)
bot.on('message_reaction', async (ctx) => {
  try {
    // Validação de segurança: garanta que apenas reações de ALLOWED_USER_ID sejam processadas
    const fromId = (ctx.from?.id || ctx.messageReaction?.user?.id)?.toString();
    if (!fromId || fromId !== ALLOWED_USER_ID) {
      console.warn(`[Security] Dropping reaction from unauthorized user ID: ${fromId || 'unknown'}`);
      return;
    }

    const mr = ctx.messageReaction;
    if (!mr) return;

    const chatId = mr.chat?.id;
    const messageId = mr.message_id;
    if (!chatId || !messageId) return;

    // Verificar se a reação adicionada pelo usuário contém corações ou emojis de afeto
    const addedEmojis = ctx.reactions().emojiAdded;
    const newReactions = mr.new_reaction || [];
    const hasAffectionReaction =
      addedEmojis.some((e) => AFFECTION_EMOJIS.includes(e)) ||
      newReactions.some((r) => r.type === 'emoji' && AFFECTION_EMOJIS.includes(r.emoji));

    if (hasAffectionReaction) {
      // 1. Adicionar reação nativa de volta na mensagem
      const randomReaction = REACTION_REPLY_EMOJIS[Math.floor(Math.random() * REACTION_REPLY_EMOJIS.length)];
      try {
        await ctx.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: randomReaction }]);
      } catch (reactErr) {
        console.warn(`[Reaction] Could not set message reaction: ${reactErr.message}`);
      }

      // 2. Enviar mensagem curta de texto escolhida aleatoriamente
      const randomMessage = AFFECTION_TEXT_RESPONSES[Math.floor(Math.random() * AFFECTION_TEXT_RESPONSES.length)];
      await sendSafeMessage(chatId, randomMessage);
    }
  } catch (error) {
    console.error('[Handler message_reaction Error]:', error);
  }
});

// Command: /start or /help
bot.command(['start', 'help'], async (ctx) => {
  const state = await getRecoveryState();
  const text = `👋 **Hello! I am Rute, your personal assistant, habit coach, and English tutor.**

🔥 **Current Streak:** ${state.streakDays} days (Best: ${state.bestStreakDays})

Here is how we work together:
• **Audio Messages:** Send me native voice notes! I will listen, respond, and coach your English pronunciation & grammar.
• **Habit & Recovery:**
  - Type \`relapse\` if you slipped. I will guide you through grounding and reset your tracker safely.
  - Type \`progress\` to see your streaks and stats.
• **English Practice:** Talk to me in English anytime for natural conversational coaching and instant corrections.
• **Daily Check-ins:** I'll keep you accountable with morning focus, evening wind-down, and nightly check-ins.

I'm ready whenever you are. How are you feeling right now?`;

  await replySafe(ctx, text);
});

// Text Trigger: Relapse / Recaída
bot.hears(/^(relapse|recaida|recaída|\/relapse)/i, async (ctx) => {
  try {
    const result = await recordRelapse();

    if (result.alreadyReset) {
      const msg = `🫂 **I hear you, and you are not alone.**

Your streak was already reset for today (Day 0). The **single-reset-day cap** is active, so you do **not** lose any additional streak days.

*Right now, focus on emotional regulation:*
1. Take 3 slow, deep diaphragmatic breaths (4s in, 7s hold, 8s out).
2. Drink a cold glass of water.
3. Step away from your computer or phone screen.
4. Remember: shame feeds the cycle; curiosity and self-compassion break it.

What led up to this moment? Tell me in text or voice when you feel ready.`;
      return await replySafe(ctx, msg);
    }

    const msg = `🫂 **Breathe. You are safe, and this is not the end.**

Your streak was reset from **${result.streakBefore} days** to **0**.
However, the neuroplasticity and discipline you built during those ${result.streakBefore} days **did not vanish**. A slip is an event, not your identity.

*Immediate reset protocol:*
1. **Physical State Shift:** Change your physical location immediately. Stand up, wash your face with cold water, or do 10 pushups.
2. **Remove the Trigger:** Put any trigger devices in another room.
3. **No Binging:** The voice telling you "since I slipped, today is ruined" is a dopamine lie. Protect the rest of your day.

I'm right here with you. What was the trigger or emotion that started this chain?`;
    await replySafe(ctx, msg);
  } catch (error) {
    console.error('[Handler] Relapse error:', error);
    await replySafe(ctx, '⚠️ An error occurred while logging. Please try again.');
  }
});

// Text Trigger: Progress / Status / Streak
bot.hears(/^(progress|progresso|status|streak|\/progress|\/status|\/streak)/i, async (ctx) => {
  try {
    const state = await getRecoveryState();
    const lastRelapseFormatted = state.lastRelapseAt
      ? new Date(state.lastRelapseAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      : 'None recorded';

    const statusBadge = state.resetDayToday
      ? '⚠️ Reset Day (Compassion & Safety Mode)'
      : '✅ Active & Clean';

    const msg = `📊 **Rute Habit & Recovery Dashboard**

🔥 **Current Streak:** ${state.streakDays} ${state.streakDays === 1 ? 'day' : 'days'}
🏆 **Best Streak:** ${state.bestStreakDays} ${state.bestStreakDays === 1 ? 'day' : 'days'}
🗓️ **Status Today:** ${statusBadge}
⏱️ **Last Relapse Logged:** ${lastRelapseFormatted}
📜 **Total History Logs:** ${state.history.length}

💪 *Consistent small actions compound into massive transformations. Keep going!*`;

    await replySafe(ctx, msg);
  } catch (error) {
    console.error('[Handler] Progress error:', error);
    await replySafe(ctx, '⚠️ Could not fetch progress right now.');
  }
});

// Voice Message Handler: Purely in-memory buffer -> Base64 -> @google/genai
bot.on(':voice', async (ctx) => {
  try {
    await ctx.replyWithChatAction('typing');

    // 1. Retrieve Telegram file info
    const voice = ctx.message.voice;
    const file = await ctx.getFile();

    if (!file.file_path) {
      throw new Error('Telegram file_path is missing from file metadata');
    }

    // 2. Download the voice file directly into memory as an ArrayBuffer
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(`Failed to download Telegram voice note: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    // Pure in-memory Base64 conversion - NO disk writes (.json/.sqlite/audio files)
    const base64Audio = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = voice.mime_type || 'audio/ogg';

    // 3. Retrieve current state context for Rute
    const state = await getRecoveryState();

    // 4. Pass directly to @google/genai via inlineData
    const genaiResponse = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio
          }
        },
        {
          text: `[Context: Current recovery streak is ${state.streakDays} days (Best: ${state.bestStreakDays}). Today resetDayToday=${state.resetDayToday}.]
Listen to this voice message from the user. Respond as Rute, their personal assistant, habit coach, and English tutor.
If they spoke in English, respond in English and include the "📝 English Coaching:" section with feedback on pronunciation/phrasing/grammar.`
        }
      ],
      config: {
        systemInstruction: RUTE_SYSTEM_PROMPT
      }
    });

    const replyText = genaiResponse.text || "I listened to your voice message, but I couldn't formulate a response. Could you say that again?";
    await replySafe(ctx, replyText);
  } catch (error) {
    console.error('[Voice Handler Error]:', error);
    await replySafe(ctx, '⚠️ I encountered an issue processing your audio message in memory. Please try again.');
  }
});

// General Text Message Handler (Coaching, English tutor, and Assistant)
bot.on('message:text', async (ctx) => {
  try {
    const userMessage = ctx.message.text;

    // Tratamento de Mensagens Contendo Apenas Emojis
    const cleanedMessage = userMessage.trim().replace(/[\uFE0F\uFE0E]/g, '');
    const isOnlyEmojis =
      /^[\p{Extended_Pictographic}\s]+$/u.test(cleanedMessage) ||
      /^[\p{Extended_Pictographic}\s]+$/u.test(userMessage.trim());

    if (isOnlyEmojis) {
      const hasAffectionEmoji = AFFECTION_EMOJIS.some((e) => userMessage.includes(e));

      if (hasAffectionEmoji) {
        // Reagir diretamente na mensagem do usuário com emoji aleatório
        const randomEmoji = REACTION_REPLY_EMOJIS[Math.floor(Math.random() * REACTION_REPLY_EMOJIS.length)];
        try {
          await ctx.react(randomEmoji);
        } catch (reactErr) {
          console.warn(`[Reaction] Could not react to message: ${reactErr.message}`);
        }
        // Encerra o processamento antes de chamar a API do Gemini para poupar tokens
        return;
      }
    }

    await ctx.replyWithChatAction('typing');

    const state = await getRecoveryState();

    const genaiResponse = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          text: `[Context: User recovery streak: ${state.streakDays} days (Best: ${state.bestStreakDays}). Today resetDayToday=${state.resetDayToday}.]
User message: "${userMessage}"`
        }
      ],
      config: {
        systemInstruction: RUTE_SYSTEM_PROMPT
      }
    });

    const replyText = genaiResponse.text || 'I received your message. How else can I support your focus today?';
    await replySafe(ctx, replyText);
  } catch (error) {
    console.error('[Text Handler Error]:', error);
    await replySafe(ctx, '⚠️ Sorry, I could not process your message right now.');
  }
});

// Catch unhandled bot errors
bot.catch((err) => {
  console.error('[GrammY Bot Catch-All Error]:', err);
});

// ==========================================
// 6. Express Server & Webhook Mount
// ==========================================
const app = express();

// Global JSON middleware
app.use(express.json());

// Mount GrammY Webhook on /telegram-webhook
app.use('/telegram-webhook', webhookCallback(bot, 'express'));

// Basic health check route
app.get(['/', '/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'Rute Telegram Assistant & Coach',
    model: GEMINI_MODEL,
    uptime: process.uptime()
  });
});

// ==========================================
// 7. Protected Cron Routes (x-cron-secret)
// ==========================================
const verifyCronAuth = (req, res, next) => {
  const secretHeader = req.headers['x-cron-secret'];
  const secretQuery = req.query?.['x-cron-secret'] || req.query?.secret || req.query?.cron_secret;
  const rawSecret = secretHeader || secretQuery;
  const providedSecret = typeof rawSecret === 'string' ? rawSecret.trim() : '';

  if (!providedSecret || providedSecret !== CRON_SECRET) {
    console.warn(`[Security] Unauthorized cron attempt with invalid or missing x-cron-secret from IP: ${req.ip}`);
    return res.status(401).json({ ok: false });
  }
  next();
};

// 7.1 Morning / Midday Focus Check-in
const handleFocusCron = async (req, res) => {
  console.log(`[Cron Trigger] /api/cron/focus disparado (${req.method}) em ${new Date().toISOString()}`);
  try {
    const state = await getRecoveryState();
    const text = `☀️ **Rute Focus Check-in**

Good morning! Time to take ownership of your day.
• **Current Streak:** ${state.streakDays} days 🔥
• **Daily Rule:** Protect your focus in the first hours. Avoid mindless scrolling.
• **Priority:** What is the ONE task that will move the needle today?

*English Challenge:* Reply to me in English with: *"Today, my main priority is..."* and tell me what you'll achieve!`;

    await sendSafeMessage(ALLOWED_USER_ID, text);
    console.log('[Cron Success] /api/cron/focus mensagem despachada com sucesso');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Cron /api/cron/focus Error]:', error);
    return res.status(500).json({ ok: false, error: 'Failed to dispatch message' });
  }
};
app.post('/api/cron/focus', verifyCronAuth, handleFocusCron);
app.get('/api/cron/focus', verifyCronAuth, handleFocusCron);

// 7.2 Evening Wind-Down Notification
const handleWindDownCron = async (req, res) => {
  console.log(`[Cron Trigger] /api/cron/wind-down disparado (${req.method}) em ${new Date().toISOString()}`);
  try {
    const text = `🕯️ **Rute Wind-Down Reminder**

The day is winding down. Give your nervous system permission to decelerate.
1. **Digital Sunset:** Disconnect from stimulating content and bright screens.
2. **Physical Boundary:** Place your phone away from where you sleep.
3. **Gratitude & Grounding:** Reflect on one moment of discipline or victory you had today.

Breathe deeply. Quality sleep is where neural pathways solidify. Rest well!`;

    await sendSafeMessage(ALLOWED_USER_ID, text);
    console.log('[Cron Success] /api/cron/wind-down mensagem despachada com sucesso');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Cron /api/cron/wind-down Error]:', error);
    return res.status(500).json({ ok: false, error: 'Failed to dispatch message' });
  }
};
app.post('/api/cron/wind-down', verifyCronAuth, handleWindDownCron);
app.get('/api/cron/wind-down', verifyCronAuth, handleWindDownCron);

// 7.3 Nightly Check-in & Recovery Evaluator
// Branches properly when resetDayToday is true: sends encouragement instead of clean check-in
const handleNightCron = async (req, res) => {
  console.log(`[Cron Trigger] /api/cron/night disparado (${req.method}) em ${new Date().toISOString()}`);
  try {
    const evaluation = await handleNightlyCronEvaluation();

    if (evaluation.wasResetDay) {
      // Branch: User had a reset earlier today.
      // Send encouragement instead of clean check-in, clearing flag for tomorrow.
      const text = `🌙 **Rute Nightly Check-in: Compassion & Reset**

Today was a reset day, but you survived it and held the line tonight.
• The single-reset-day cap protected your focus from spiraling.
• Tomorrow is Day 1 — a completely clean slate.

Forgive yourself, let go of today's friction, and get restorative rest. Tomorrow we wake up and execute. I am right by your side.`;

      await sendSafeMessage(ALLOWED_USER_ID, text);
      console.log('[Cron Success] /api/cron/night mensagem de incentivo (reset day) despachada');
      return res.status(200).json({ ok: true });
    }

    // Branch: Clean day completed! Increment streak and celebrate.
    const text = `🌙 **Rute Nightly Check-in: Clean Day Completed!** 🔥

Another day of discipline and victory in the books!
• **Current Streak:** ${evaluation.streakDays} ${evaluation.streakDays === 1 ? 'day' : 'days'}
• **Best Streak:** ${evaluation.bestStreakDays} days

Every clean day rewires your dopamine pathways and builds self-trust. Rest deeply tonight — you earned this progress!`;

    await sendSafeMessage(ALLOWED_USER_ID, text);
    console.log('[Cron Success] /api/cron/night mensagem clean day despachada');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Cron /api/cron/night Error]:', error);
    return res.status(500).json({ ok: false, error: 'Failed to dispatch message' });
  }
};
app.post('/api/cron/night', verifyCronAuth, handleNightCron);
app.get('/api/cron/night', verifyCronAuth, handleNightCron);

// Fallback error handler for Express
app.use((err, req, res, next) => {
  console.error('[Express Internal Error]:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==========================================
// 8. Start Express Server
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Rute Bot server listening on port ${PORT}`);
  console.log(`🔗 Webhook endpoint: /telegram-webhook`);
  console.log(`🛡️ Authorized Telegram User ID: ${ALLOWED_USER_ID}`);
  console.log('Rotas registadas:');
  app._router.stack.forEach((r) => {
    if (r.route && r.route.path) {
      console.log(`${Object.keys(r.route.methods).join(',').toUpperCase()} ${r.route.path}`);
    }
  });
});
