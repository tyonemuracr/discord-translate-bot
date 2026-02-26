// server.js (discord.js v13) - Render Free 安定版 (ja + en)
// - /healthz でOK返す（UptimeRobot用）
// - settings.json でマルチサーバー対応
// - Webhook Unknown Webhook(404/10015) 自動復旧
// - 例外をログに出して落ちにくくする

const http = require("http");
const fs = require("fs");
const fetch = require("node-fetch");
const { Client, Intents } = require("discord.js");

// ================== KEEP ALIVE (Render/Railway用) ==================
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

// ================== SETTINGS LOAD (マルチサーバー) ==================
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
  // 壊れにくい保存（tmp→rename）
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

// 落ちた原因が分かるようにする（重要）
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ================= READY =================
client.on("ready", async () => {
  console.log(`${client.user.tag} にログインしました`);
  client.user.setPresence({ status: "online" });
});

// ================= WEBHOOK HELPERS =================
async function getValidWebhook(channel) {
  let wh = cacheWebhooks.get(channel.id);

  // キャッシュがあるなら生存確認
  if (wh) {
    try {
      await wh.fetch();
      return wh;
    } catch (_) {
      cacheWebhooks.delete(channel.id);
      wh = null;
    }
  }

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

async function safeWebhookSend(channel, payload) {
  try {
    const webhook = await getValidWebhook(channel);
    return await webhook.send(payload);
  } catch (e) {
    // 直せない系は再作成ループに入らない
    if (e?.code === 50013 || e?.code === 50001 || e?.code === 10003) {
      console.error("Webhook send failed (no perm/access/channel):", e?.code);
      return null;
    }

    // Unknown Webhook / 404 は作り直して再送
    if (e?.code === 10015 || e?.status === 404 || e?.httpStatus === 404) {
      cacheWebhooks.delete(channel.id);

      // 念のため古いWebhook掃除（失敗しても無視）
      try {
        const webhooks = await channel.fetchWebhooks();
        const ours = webhooks.find((w) => w.name === "Translate" && w.token);
        if (ours) await ours.delete().catch(() => {});
      } catch (_) {}

      const webhook = await getValidWebhook(channel);
      return await webhook.send(payload);
    }

    throw e;
  }
}

// ================= MESSAGE =================
client.on("messageCreate", async (message) => {
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

      // 並列で翻訳（速い）
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

// ================= LOGIN =================
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log("DISCORD_BOT_TOKEN が設定されていません");
  process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);
