// server.js
// discord.js v13
// 表示重視 + 安定版（調整版）
// - 送信者名/アイコンは webhook で再現
// - 本文に「from: 名前」は入れない
// - /healthz 対応
// - マルチサーバー対応
// - webhook キャッシュ
// - webhook 429/404 時は通常送信にフォールバック
// - 翻訳タイムアウトを長めに調整
// - 古い翻訳の破棄
// - stop/start 後の古いジョブ無効化
// - チャンネルごとの直列キュー

const http = require("http");
const fs = require("fs");
const fetch = require("node-fetch");
const { Client, Intents } = require("discord.js");

console.log("SERVER.JS LOADED");

// ================== CONFIG ==================
const prefix = "v!";

const GAS_BASE_URL =
  "https://script.google.com/macros/s/AKfycbx2zxXArFJuPDctM7zrFEz73kVI6Y8JUcpr_GkxnyZeJT4c4mx8rSTSL-dqD4x7fEed/exec";

// 翻訳API待機時間（長め）
const GAS_TIMEOUT_MS = 15000;

// 受信からこれ以上経った翻訳結果は捨てる
const MAX_TRANSLATION_AGE_MS = 30000;

// 送信間隔
const MIN_SEND_INTERVAL_MS = 1200;

// 処理済みID保持時間
const PROCESSED_TTL_MS = 10 * 60 * 1000;

// ================== KEEP ALIVE ==================
http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.statusCode = 200;
      return res.end("ok");
    }
    res.statusCode = 200;
    res.end("ok");
  })
  .listen(process.env.PORT || 3000);

// ================== SETTINGS ==================
let settings = {};
try {
  settings = require("./settings.json");
} catch (_) {
  settings = {};
}
if (!settings.guilds) settings.guilds = {};

function ensureGuild(gid) {
  if (!settings.guilds[gid]) {
    settings.guilds[gid] = { trst: 0, msgch: 0 };
  }
}

function saveSettings() {
  const tmp = "./settings.tmp.json";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, "./settings.json");
}

// ================== CLIENT ==================
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_WEBHOOKS,
  ],
});

// ================== RUNTIME STATE ==================
const guildGeneration = new Map();
const channelQueues = new Map();
const channelLastSendAt = new Map();
const processedMessageIds = new Map();
const webhookCache = new Map();

function getGuildGeneration(gid) {
  if (!guildGeneration.has(gid)) guildGeneration.set(gid, 1);
  return guildGeneration.get(gid);
}

function bumpGuildGeneration(gid) {
  const next = getGuildGeneration(gid) + 1;
  guildGeneration.set(gid, next);
  return next;
}

function markProcessed(messageId) {
  processedMessageIds.set(messageId, Date.now());
}

function isProcessed(messageId) {
  const ts = processedMessageIds.get(messageId);
  if (!ts) return false;

  if (Date.now() - ts > PROCESSED_TTL_MS) {
    processedMessageIds.delete(messageId);
    return false;
  }
  return true;
}

function cleanupProcessedIds() {
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > PROCESSED_TTL_MS) {
      processedMessageIds.delete(id);
    }
  }
}

setInterval(cleanupProcessedIds, 60 * 1000);

// ================== LOGS ==================
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

client.on("error", (err) => {
  console.error("CLIENT ERROR:", err);
});

client.on("shardError", (err) => {
  console.error("SHARD ERROR:", err);
});

client.on("disconnect", (event) => {
  console.error("DISCONNECTED:", event);
});

client.on("warn", (msg) => {
  console.log("WARN:", msg);
});

client.on("rateLimit", (info) => {
  console.log("RATE LIMIT:", info);
});

client.on("debug", (msg) => {
  if (
    msg.includes("Preparing to connect") ||
    msg.includes("Connecting to gateway") ||
    msg.includes("Identifying") ||
    msg.includes("[READY]") ||
    msg.includes("[RESUME]") ||
    msg.includes("Fetched Gateway Information") ||
    msg.includes("Hit a 429")
  ) {
    console.log("DEBUG:", msg);
  }
});

// ================== READY ==================
client.on("ready", () => {
  console.log(`${client.user.tag} にログインしました`);
  client.user.setPresence({ status: "online" });
});

// ================== HELPERS ==================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateWithTimeout(text, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);

  try {
    const url =
      `${GAS_BASE_URL}?text=${encodeURIComponent(text)}&source=&target=${encodeURIComponent(target)}`;
    const res = await fetch(url, { signal: controller.signal });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function buildTranslationContent(ja, en) {
  let content = `ja: ${truncate(ja, 950)}\nen: ${truncate(en, 950)}`;
  if (content.length > 1900) {
    content = truncate(content, 1900);
  }
  return content;
}

async function sendWithSpacing(channel, sendFn) {
  const now = Date.now();
  const last = channelLastSendAt.get(channel.id) || 0;
  const wait = Math.max(0, MIN_SEND_INTERVAL_MS - (now - last));

  if (wait > 0) {
    await sleep(wait);
  }

  const result = await sendFn();
  channelLastSendAt.set(channel.id, Date.now());
  return result;
}

function enqueueChannelJob(channelId, job) {
  const prev = channelQueues.get(channelId) || Promise.resolve();

  const next = prev
    .catch(() => {})
    .then(job)
    .catch((err) => {
      console.error("QUEUE JOB ERROR:", err);
    });

  channelQueues.set(channelId, next);
  return next;
}

function shouldDropByAge(messageCreatedAt) {
  return Date.now() - messageCreatedAt > MAX_TRANSLATION_AGE_MS;
}

// ================== WEBHOOK ==================
async function getCachedWebhook(channel) {
  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find((w) => w.token && w.name === "Translate");

  if (!webhook) {
    webhook = await channel.createWebhook("Translate", {
      avatar: client.user.displayAvatarURL(),
    });
  }

  webhookCache.set(channel.id, webhook);
  return webhook;
}

async function sendFallbackMessage(channel, content) {
  return sendWithSpacing(channel, async () => {
    return channel.send({
      content,
      allowedMentions: { parse: [] },
    });
  });
}

async function safeSendTranslatedMessage(channel, payload) {
  try {
    return await sendWithSpacing(channel, async () => {
      const webhook = await getCachedWebhook(channel);
      return webhook.send(payload);
    });
  } catch (e) {
    if (e?.status === 429 || e?.httpStatus === 429) {
      console.error("Webhook 429. Fallback to normal send.");
      return sendFallbackMessage(channel, payload.content);
    }

    if (e?.code === 10015 || e?.status === 404 || e?.httpStatus === 404) {
      console.error("Unknown Webhook. Recreating...");
      webhookCache.delete(channel.id);

      try {
        const webhooks = await channel.fetchWebhooks();
        const ours = webhooks.find((w) => w.name === "Translate" && w.token);
        if (ours) await ours.delete().catch(() => {});
      } catch (_) {}

      try {
        return await sendWithSpacing(channel, async () => {
          const webhook = await getCachedWebhook(channel);
          return webhook.send(payload);
        });
      } catch (err) {
        console.error("Webhook recreate failed. Fallback to normal send:", err);
        return sendFallbackMessage(channel, payload.content);
      }
    }

    if (e?.code === 50013 || e?.code === 50001 || e?.code === 10003) {
      console.error("Webhook permission/access/channel error:", e?.code);
      return sendFallbackMessage(channel, payload.content);
    }

    console.error("safeSendTranslatedMessage error:", e);
    return sendFallbackMessage(channel, payload.content);
  }
}

// ================== MESSAGE ==================
client.on("messageCreate", async (message) => {
  console.log("MESSAGE EVENT:", message.content);

  if (!message.guild) return;
  if (message.author.bot) return;

  const gid = message.guild.id;
  ensureGuild(gid);

  const content = (message.content || "").trim();
  if (!content) return;

  // -------- COMMAND --------
  if (content.startsWith(prefix)) {
    const args = content.slice(prefix.length).trim().split(/ +/g);
    const command = (args.shift() || "").toLowerCase();

    if (command === "start") {
      settings.guilds[gid] = {
        trst: 1,
        msgch: message.channel.id,
      };
      saveSettings();
      bumpGuildGeneration(gid);
      return message.reply("✅ 自動翻訳を開始しました（ja / en）");
    }

    if (command === "stop") {
      settings.guilds[gid] = {
        trst: 0,
        msgch: 0,
      };
      saveSettings();
      bumpGuildGeneration(gid);
      return message.reply("🛑 自動翻訳を停止しました");
    }

    if (command === "help") {
      return message.channel.send(
        `**${prefix}start** 自動翻訳ON（このチャンネル）\n` +
        `**${prefix}stop** 自動翻訳OFF\n`
      );
    }

    if (command === "status") {
      const state = settings.guilds[gid];
      return message.reply(
        state.trst === 1 ? `ON: <#${state.msgch}>` : "OFF"
      );
    }

    return;
  }

  // -------- AUTO TRANSLATE --------
  if (
    settings.guilds[gid].trst !== 1 ||
    message.channel.id !== settings.guilds[gid].msgch
  ) {
    return;
  }

  if (isProcessed(message.id)) return;
  markProcessed(message.id);

  const generationAtReceive = getGuildGeneration(gid);
  const messageCreatedAt = message.createdTimestamp;
  const originalText = content;
  const displayName = message.member?.displayName || message.author.username;
  const avatarURL = message.author.displayAvatarURL({ dynamic: true }) || undefined;

  enqueueChannelJob(message.channel.id, async () => {
    if (settings.guilds[gid].trst !== 1) {
      console.log("DROP: translation finished after stop");
      return;
    }

    if (message.channel.id !== settings.guilds[gid].msgch) {
      console.log("DROP: target channel changed");
      return;
    }

    if (generationAtReceive !== getGuildGeneration(gid)) {
      console.log("DROP: stale generation before translate");
      return;
    }

    if (shouldDropByAge(messageCreatedAt)) {
      console.log("DROP: stale age before translate");
      return;
    }

    let ja;
    let en;

    try {
      [ja, en] = await Promise.all([
        translateWithTimeout(originalText, "ja"),
        translateWithTimeout(originalText, "en"),
      ]);
    } catch (err) {
      if (err.name === "AbortError") {
        console.log("DROP: translation timeout");
        return;
      }
      console.error("TRANSLATE ERROR:", err);
      return;
    }

    if (settings.guilds[gid].trst !== 1) {
      console.log("DROP: translation finished after stop");
      return;
    }

    if (message.channel.id !== settings.guilds[gid].msgch) {
      console.log("DROP: target channel changed after translate");
      return;
    }

    if (generationAtReceive !== getGuildGeneration(gid)) {
      console.log("DROP: stale generation after translate");
      return;
    }

    if (shouldDropByAge(messageCreatedAt)) {
      console.log("DROP: stale age after translate");
      return;
    }

    if (!ja || !en) {
      console.log("DROP: empty translation");
      return;
    }

    if (ja === en) {
      console.log("DROP: same translation");
      return;
    }

    const translatedContent = buildTranslationContent(ja, en);

    await safeSendTranslatedMessage(message.channel, {
      content: translatedContent,
      username: displayName,
      avatarURL,
      allowedMentions: { parse: [] },
    });
  });
});

// ================== LOGIN ==================
console.log("BOT START: login section reached");

if (!process.env.DISCORD_BOT_TOKEN) {
  console.log("DISCORD_BOT_TOKEN が設定されていません");
  process.exit(1);
}

console.log(
  "TOKEN CHECK:",
  typeof process.env.DISCORD_BOT_TOKEN,
  process.env.DISCORD_BOT_TOKEN.length
);

console.log("Calling client.login(...)");

client
  .login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log("client.login resolved");
  })
  .catch((err) => {
    console.error("Discord login failed:", err);
  });
