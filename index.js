require("dotenv").config();
const Framework = require("webex-node-bot-framework");
const webhook = require("webex-node-bot-framework/webhook");
const express = require("express");
const Groq = require("groq-sdk");

// ─── Validate required env vars ───────────────────────────────────────────────
const required = ["WEBEX_ACCESS_TOKEN", "GROQ_API_KEY", "PORT"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌  Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ─── Groq setup ───────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Model choice — llama-3.3-70b-versatile is the most capable free model on Groq
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_PROMPT =
  process.env.BOT_PERSONA ||
  "You are a helpful, friendly assistant in a Webex group chat. " +
  "Keep responses concise and clear. " +
  "Use markdown sparingly — Webex renders **bold** and *italic* but not tables.";

// Per-room conversation history (in-memory; resets on bot restart)
// Structure: { roomId: [{ role: "user"|"assistant", content: string }] }
const conversations = new Map();

async function askGroq(roomId, userMessage) {
  if (!conversations.has(roomId)) {
    conversations.set(roomId, []);
  }
  const history = conversations.get(roomId);

  // Build the messages array: system prompt + conversation history + new message
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages,
    max_tokens: 1024,
    temperature: 0.7,
  });

  const reply = completion.choices[0]?.message?.content || "Sorry, I got an empty response.";

  // Save to history, keep last 20 turns (40 messages) to avoid token bloat
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: reply });
  if (history.length > 40) history.splice(0, history.length - 40);

  return reply;
}

// ─── Express + Webex framework setup ─────────────────────────────────────────
const app = express();
app.use(express.json());

const config = {
  webhookUrl: process.env.WEBHOOK_URL,
  token: process.env.WEBEX_ACCESS_TOKEN,
  port: parseInt(process.env.PORT, 10),
};

const framework = new Framework(config);
framework.start();

// ─── Bot events ───────────────────────────────────────────────────────────────

framework.on("initialized", () => {
  console.log(`✅  Bot is live! Using model: ${MODEL}`);
  console.log(`🚀  Listening on port ${config.port}`);
});

// Special command: reset conversation history for this room (higher priority = runs first)
framework.hears(
  /^reset$/i,
  async (bot, trigger) => {
    conversations.delete(trigger.roomId);
    await bot.say("🔄 Conversation history cleared for this room!");
  },
  1
);

// Special command: help
framework.hears(
  /^help$/i,
  async (bot) => {
    await bot.say(
      "markdown",
      "## 🤖 AI Bot Commands\n\n" +
      "- **@BotName <question>** — Ask me anything!\n" +
      "- **reset** — Clear conversation history for this room\n" +
      "- **help** — Show this message\n\n" +
      `_Powered by Groq · Model: ${MODEL}_`
    );
  },
  1
);

// Catch-all: respond to any message (group @mention or DM)
framework.hears(
  /(.+)/,
  async (bot, trigger) => {
    const userText = trigger.text
      .replace(new RegExp(`^@?${escapeRegex(bot.person.displayName)}\\s*`, "i"), "")
      .trim();

    if (!userText) {
      await bot.say("Hey! Mention me with a question and I'll help out. 😊");
      return;
    }

    try {
      const reply = await askGroq(trigger.roomId, userText);
      await bot.say("markdown", reply);
    } catch (err) {
      console.error("Groq error:", err.message);

      if (err.status === 429) {
        await bot.say("⏳ Kurze Pause — bitte in ein paar Sekunden nochmal versuchen!");
      } else {
        await bot.say("⚠️ Es gab ein Problem mit der KI. Bitte nochmal versuchen.");
      }
    }
  },
  10
);

// ─── Webhook route ────────────────────────────────────────────────────────────
app.post("/webhook", webhook(framework));

app.get("/", (_req, res) =>
  res.send(`Webex AI Bot (Groq · ${MODEL}) is running ✅`)
);

app.listen(config.port, () => {
  console.log(`🌐  Server started on port ${config.port}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
