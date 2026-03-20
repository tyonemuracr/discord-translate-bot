// server.js (discord.js v13) - 安定版
// - /healthz 対応
// - マルチサーバー対応
// - Webhook 404 自動復旧
// - Webhook 429 時は通常メッセージ送信にフォールバック
// - Discordログイン状況をログ出力

const http = require("http");
const fs = require("fs");
const fetch = require("node-fetch");
const { Client, Intents } = require("discord.js");

console.log("SERVER.JS LOADED");

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

// ================== SETTINGS LOAD ==================
let settings = {};
try {
  settings = require("./settings.json");
} catch (_) {
  settings = {};
}
if (!settings.guilds) settings.guilds = {};

function ensureGuild(gid) {
  if (!settings.guilds[gid]) settings.guilds[gid] = { trst: 0, msgch: 0 };
}

function saveSettings() {
  const tmp = "./settings.tmp.json";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, "./settings.json");
}

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_WEBHOOKS,
  ],
});

const prefix = "v!";
const cacheWebhooks = new Map();

// ================== DEBUG / ERROR LOG ==================
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
    msg.includes("READY") ||
    msg.includes("RESUME") ||
    msg.includes("Fetched Gateway Information") ||
    msg.includes("Hit a 429")
  ) {
    console.log("DEBUG FULL:", msg);
  }
});

// ================== READY ==================
client.on("ready", async () => {
  console.log(`${client.user.tag} にログインしました`);
  client.user.setPresence({ status: "online" });
});

// ================== WEBHOOK HELPERS ==================
async function getValidWebhook(channel) {
  let wh = cacheWebhooks.get(channel.id);
  if (wh) return wh;

  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find((w) => w.token);

  if (!webhook) {
    webhook = await channel.createWebhook("Translate", {
      avatar: client.user.displayAvatarURL(),
    });
  }

  cacheWebhooks.set(channel.id, webhook);
  return webhook;
}

async function fallbackNormalSend(channel, payload) {
  try {
    return await channel.send(payload.content);
  } catch (err) {
    console.error("Fallback normal send failed:", err);
    return null;
  }
}

async function safeWebhookSend(channel, payload) {
  try {
    const webhook = await getValidWebhook(channel);
    return await webhook.send(payload);
  } catch (e) {
    // 権限 / アクセス / チャンネル消滅
    if (e?.code === 50013 || e?.code === 50001 || e?.code === 10003) {
      console.error("Webhook send failed (no perm/access/channel):", e?.code);
      return fallbackNormalSend(channel, payload);
    }

    // Webhook API のレート制限
    if (e?.status === 429 || e?.httpStatus === 429) {
      console.error("Webhook route rate-limited. Fallback to normal send.");
      return fallbackNormalSend(channel, payload);
    }

    // Unknown Webhook / 404
    if (e?.code === 10015 || e?.status === 404 || e?.httpStatus === 404) {
      console.error("Unknown Webhook. Recreating...");
      cacheWebhooks.delete(channel.id);

      try {
        const webhooks = await channel.fetchWebhooks();
        const ours = webhooks.find((w) => w.name === "Translate" && w.token);
        if (ours) await ours.delete().catch(() => {});
      } catch (_) {}

      try {
        const webhook = await getValidWebhook(channel);
        return await webhook.send(payload);
      } catch (err) {
        console.error("Webhook recreate failed. Fallback to normal send:", err);
        return fallbackNormalSend(channel, payload);
      }
    }

    console.error("safeWebhookSend error:", e);
    return fallbackNormalSend(channel, payload);
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

  // ---------- COMMAND ----------
  if (content.startsWith(prefix)) {
    const args = content.slice(prefix.length).trim().split(/ +/g);
    const command = (args.shift() || "").toLowerCase();

    if (command === "start") {
      if (settings.guilds[gid].trst === 1) {
        return message.reply(
          `すでにこのサーバーで有効です（<#${settings.guilds[gid].msgch}>）`
        );
      }
      settings.guilds[gid] = { trst: 1, msgch: message.channel.id };
      saveSettings();
      return message.reply("✅ 自動翻訳を開始しました（ja / en）");
    }

    if (command === "stop") {
      settings.guilds[gid] = { trst: 0, msgch: 0 };
      saveSettings();
      return message.reply("🛑 自動翻訳を停止しました");
    }

    if (command === "help") {
      return message.channel.send(
        `**${prefix}start** 自動翻訳ON（このチャンネル）\n` +
          `**${prefix}stop** 自動翻訳OFF\n`
      );
    }

    return;
  }

  // ---------- AUTO TRANSLATE ----------
  if (
    settings.guilds[gid].trst === 1 &&
    message.channel.id === settings.guilds[gid].msgch
  ) {
    try {
      const text = encodeURIComponent(content);
      const base =
        "https://script.google.com/macros/s/AKfycbx2zxXArFJuPDctM7zrFEz73kVI6Y8JUcpr_GkxnyZeJT4c4mx8rSTSL-dqD4x7fEed/exec";

      const [ja, en] = await Promise.all([
        fetch(`${base}?text=${text}&source=&target=ja`).then((r) => r.text()),
        fetch(`${base}?text=${text}&source=&target=en`).then((r) => r.text()),
      ]);

      if (!ja || !en) return;
      if (ja === en) return;

      await safeWebhookSend(message.channel, {
        content: `ja: ${ja}\nen: ${en}`,
        username: `from: ${message.member?.displayName || message.author.username}`,
        avatarURL: message.author.displayAvatarURL({ dynamic: true }),
      });
    } catch (e) {
      console.error("translate/send error:", e);
    }
  }
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
