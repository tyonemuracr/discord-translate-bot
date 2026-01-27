const Discord = require("discord.js");
const fs = require("fs");
const fetch = require("node-fetch");

const { Client, Intents } = Discord;

const options = {
  intents: [
    "GUILDS",
    "GUILD_MESSAGES",
    "GUILD_WEBHOOKS",
  ],
};

const client = new Client(options);
const prefix = "v!";

const cacheWebhooks = new Map();
let settings = require("./settings.json");

if (!settings.guilds) settings.guilds = {};

// ================= READY =================
client.on("ready", async () => {
  console.log(client.user.tag + " にログインしました");
  client.user.setPresence({ status: "online" });
});

// ================= MESSAGE =================
client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const gid = message.guild.id;
  if (!settings.guilds[gid]) settings.guilds[gid] = { trst: 0, msgch: 0 };

  // ---------- COMMAND ----------
  if (message.content.startsWith(prefix)) {
    const args = message.content.slice(prefix.length).trim().split(/ +/g);
    const command = args.shift().toLowerCase();

    // START
    if (command === "start") {
      if (settings.guilds[gid].trst === 1) {
        return message.reply("すでに他のチャンネルで有効です。");
      }

      settings.guilds[gid] = {
        trst: 1,
        msgch: message.channel.id,
      };
      saveSettings();
      return message.reply("✅ 自動翻訳を開始しました");
    }

    // STOP
    if (command === "stop") {
      settings.guilds[gid] = {
        trst: 0,
        msgch: 0,
      };
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
    try {
      const text = encodeURIComponent(message.content);

      const ja = await fetch(
        `https://script.google.com/macros/s/AKfycbx2zxXArFJuPDctM7zrFEz73kVI6Y8JUcpr_GkxnyZeJT4c4mx8rSTSL-dqD4x7fEed/exec?text=${text}&source=&target=ja`
      ).then((r) => r.text());

      const en = await fetch(
        `https://script.google.com/macros/s/AKfycbx2zxXArFJuPDctM7zrFEz73kVI6Y8JUcpr_GkxnyZeJT4c4mx8rSTSL-dqD4x7fEed/exec?text=${text}&source=&target=en`
      ).then((r) => r.text());

      if (!ja || !en || ja === en) return;

      const webhook = await getWebhookInChannel(message.channel);

      await webhook.send({
        content: `ja: ${ja}\nen: ${en}`,
        username: `from: ${message.member.displayName}`,
        avatarURL: message.author.displayAvatarURL({ dynamic: true }),
      });
    } catch (e) {
      console.error(e);
    }
  }
});

// ================= LOGIN =================
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log("DISCORD_BOT_TOKEN が設定されていません");
  process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);

// ================= UTILS =================
function saveSettings() {
  fs.writeFileSync("./settings.json", JSON.stringify(settings, null, 2));
}

async function getWebhookInChannel(channel) {
  const cached = cacheWebhooks.get(channel.id);
  if (cached) return cached;

  const webhooks = await channel.fetchWebhooks();
  const webhook =
    webhooks.find((w) => w.token) || (await channel.createWebhook("Translate"));

  cacheWebhooks.set(channel.id, webhook);
  return webhook;
}
