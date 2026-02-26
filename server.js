const http = require("http");

http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.statusCode = 200;
    return res.end("ok");
  }
  res.statusCode = 200;
  res.end("ok");
}).listen(process.env.PORT || 3000);
// server.js (discord.js v13 / Render & Railway 対応・コピペ版)

const Discord = require("discord.js");
const fs = require("fs");
const fetch = require("node-fetch");
const http = require("http");

const { Client, Intents } = Discord;

// ================== KEEP ALIVE (Render/Railway用) ==================
http
  .createServer((req, res) => {
    // RenderのHealth Check Pathに /healthz を入れるならここで返す
    if (req.url === "/healthz") {
      res.statusCode = 200;
      return res.end("ok");
    }
    res.statusCode = 200;
    res.end("ok");
  })
  .listen(process.env.PORT || 3000);

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

// ================== SETTINGS LOAD ==================
let settings = {};
try {
  settings = require("./settings.json");
} catch {
  settings = {};
}
if (!settings.guilds) settings.guilds = {};

// ================== READY ==================
client.on("ready", async () => {
  console.log(`${client.user.tag} にログインしました`);
  client.user.setPresence({ status: "online" });
});

// ================== MESSAGE ==================
client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const gid = message.guild.id;
  if (!settings.guilds[gid]) settings.guilds[gid] = { trst: 0, msgch: 0 };

  // ---------- COMMAND ----------
  if (message.content.startsWith(prefix)) {
    const args = message.content.slice(prefix.length).trim().split(/ +/g);
    const command = (args.shift() || "").toLowerCase();

    // START
    if (command === "start") {
      if (settings.guilds[gid].trst === 1) {
        return message.reply("すでに他のチャンネルで有効です。");
      }
      settings.guilds[gid] = { trst: 1, msgch: message.channel.id };
      saveSettings();
      return message.reply("✅ 自動翻訳を開始しました");
    }

    // STOP
    if (command === "stop") {
      settings.guilds[gid] = { trst: 0, msgch: 0 };
      saveSettings();
      return message.reply("🛑 自動翻訳を停止しました");
    }

    return;
  }

  // ---------- AUTO TRANSLATE ----------
  if (
    settings.guilds[gid].trst === 1 &&
    message.channel.id === settings.guilds[gid].msgch
  ) {
    const content = (message.content || "").trim();
    if (!content) return;

    try {
      const text = encodeURIComponent(content);
      const base =
        "https://script.google.com/macros/s/AKfycbx2zxXArFJuPDctM7zrFEz73kVI6Y8JUcpr_GkxnyZeJT4c4mx8rSTSL-dqD4x7fEed/exec";

      // 並列で翻訳（速くなる）
      const [ja, en] = await Promise.all([
        fetch(`${base}?text=${text}&source=&target=ja`).then((r) => r.text()),
        fetch(`${base}?text=${text}&source=&target=en`).then((r) => r.text()),
      ]);

      if (!ja || !en || ja === en) return;

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
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log("DISCORD_BOT_TOKEN が設定されていません");
  process.exit(0);
}
client.login(process.env.DISCORD_BOT_TOKEN);

// ================== UTILS ==================
function saveSettings() {
  // 破損しにくい保存（tmp→rename）
  const tmp = "./settings.tmp.json";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, "./settings.json");
}

// Webhookを取得（キャッシュ）＋ 事前に生存確認してダメなら作り直し
async function getValidWebhook(channel) {
  let wh = cacheWebhooks.get(channel.id);

  if (wh) {
    try {
      await wh.fetch(); // 生存確認
      return wh;
    } catch (_) {
      cacheWebhooks.delete(channel.id);
      wh = null;
    }
  }

  const webhooks = await channel.fetchWebhooks();

  // token がある webhook（= 実際に送れる）を優先。なければ作成
  let webhook = webhooks.find((w) => w.token);
  if (!webhook) webhook = await channel.createWebhook("Translate");

  cacheWebhooks.set(channel.id, webhook);
  return webhook;
}

async function safeWebhookSend(channel, payload) {
  try {
    const webhook = await getValidWebhook(channel);
    return await webhook.send(payload);
  } catch (e) {
    // 直せない系（権限/アクセス/チャンネル消滅）は再作成ループに入らない
    if (e?.code === 50013 || e?.code === 50001 || e?.code === 10003) {
      console.error("Webhook send failed (no access/perm/channel):", e?.code);
      return;
    }

    // Unknown Webhook / 404 のときは作り直して再送
    if (e?.code === 10015 || e?.httpStatus === 404 || e?.status === 404) {
      cacheWebhooks.delete(channel.id);

      // 念のため「Translate」webhook を掃除（失敗しても無視）
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

