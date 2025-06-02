// Load environment variables (only needed for local development)
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField,
} = require("discord.js");
const axios = require("axios");
const fs = require("fs").promises;
const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");

// Import proxies if file exists, otherwise use empty array
let proxies = [];
try {
    proxies = require("./proxies.js");
} catch (error) {
    console.log("No proxies.js file found, running without proxies");
}

class VanityMonitorBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });

        this.monitoredVanities = new Map();
        this.autoSwapVanities = new Map();
        this.dataFile = "./vanity_data.json";
        this.autoSwapDataFile = "./autoswap_data.json";
        this.checkInterval = 30000;

        this.proxies = proxies || [];
        this.currentProxyIndex = 0;

        this.setupEventHandlers();
        this.loadData();
        this.loadAutoSwapData();
    }

    getRandomProxy() {
        if (this.proxies.length === 0) return null;
        const proxy = this.proxies[this.currentProxyIndex];
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
        const [host, port, username, password] = proxy.split(':');
        return { host, port: parseInt(port), auth: `${username}:${password}` };
    }

    createProxyAgent() {
        const proxy = this.getRandomProxy();
        if (!proxy) return null;
        const proxyUrl = `http://${proxy.auth}@${proxy.host}:${proxy.port}`;
        return new HttpsProxyAgent(proxyUrl);
    }

    setupEventHandlers() {
        this.client.once("ready", () => {
            console.log(`${this.client.user.tag} is online!`);
            this.sendCreditsMessage();
            this.startMonitoring();
        });

        this.client.on("guildCreate", async (guild) => {
            console.log(`Bot added to new server: ${guild.name}`);
            this.sendCreditsMessageToGuild(guild);
        });

        this.client.on("messageCreate", async (message) => {
            if (message.author.bot) return;
            if (!message.content.startsWith(",")) return;

            const args = message.content.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            if (command === "add") {
                await this.handleAddCommand(message, args);
            } else if (command === "remove") {
                await this.handleRemoveCommand(message, args);
            } else if (command === "list") {
                await this.handleListCommand(message);
            } else if (command === "autoswap") {
                await this.handleAutoSwapCommand(message, args);
            } else if (command === "removeautoswap") {
                await this.handleRemoveAutoSwapCommand(message, args);
            } else if (command === "listautoswap") {
                await this.handleListAutoSwapCommand(message);
            } else if (command === "help") {
                await this.handleHelpCommand(message);
            }
        });
    }

    async sendCreditsMessage() {
        for (const guild of this.client.guilds.cache.values()) {
            await this.sendCreditsMessageToGuild(guild);
        }
    }

    async sendCreditsMessageToGuild(guild) {
        try {
            const channel = guild.channels.cache.find(
                channel =>
                    channel.type === 0 &&
                    channel.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
            );
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor("#7289da")
                    .setTitle("🤖 Vanity Monitor Bot")
                    .setDescription("Use `,help` for commands.");
                await channel.send({ embeds: [embed] });
            }
        } catch (e) {
            console.log(`Could not send credits to guild ${guild.id}: ${e.message}`);
        }
    }

    async handleAddCommand(message, args) {
        if (!args[0]) {
            return message.reply("Usage: `,add <vanity_url>`");
        }
        const vanityUrl = args[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!vanityUrl || vanityUrl.length < 2) {
            return message.reply("Please provide a valid vanity URL (letters, numbers, and hyphens only).");
        }
        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        const existingEntry = this.monitoredVanities.get(vanityKey);
        if (existingEntry && existingEntry.userId === message.author.id) {
            return message.reply(`You are already monitoring the vanity: **${vanityUrl}**`);
        }
        const vanityExists = await this.checkVanityExists(vanityUrl);
        if (!vanityExists) {
            return message.reply(`The vanity **${vanityUrl}** is currently available! You can claim it now.`);
        }
        this.monitoredVanities.set(vanityKey, {
            userId: message.author.id,
            channelId: message.channel.id,
            guildId: guildId,
            vanityUrl: vanityUrl,
            addedAt: Date.now(),
        });
        await this.saveData();
        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("✅ Vanity Added to Monitor")
            .setDescription(`Now monitoring **${vanityUrl}** for availability`)
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async handleRemoveCommand(message, args) {
        if (!args[0]) {
            return message.reply("Usage: `,remove <vanity_url>`");
        }
        const vanityUrl = args[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        const entry = this.monitoredVanities.get(vanityKey);
        if (!entry || entry.userId !== message.author.id) {
            return message.reply(`You are not monitoring the vanity: **${vanityUrl}**`);
        }
        this.monitoredVanities.delete(vanityKey);
        await this.saveData();
        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ Vanity Removed")
            .setDescription(`Stopped monitoring **${vanityUrl}**`)
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async handleListCommand(message) {
        const guildId = message.guild?.id || "dm";
        const userVanities = Array.from(this.monitoredVanities.entries()).filter(
            ([key, data]) => {
                const [keyGuildId] = key.split('_');
                return keyGuildId === guildId && data.userId === message.author.id;
            }
        );
        if (userVanities.length === 0) {
            return message.reply("You don't have any vanities monitored in this server. Use `,add <vanity>` to add one.");
        }
        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("🔎 Your Monitored Vanities")
            .setDescription(userVanities.map(([key, data]) => `• **${data.vanityUrl}**`).join("\n"))
            .setFooter({ text: `Total: ${userVanities.length} in this server` })
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async handleAutoSwapCommand(message, args) {
        if (args.length < 2) {
            return message.reply("Usage: `,autoswap <vanity_url> <target_guild_id>`\nExample: `,autoswap cool-server 123456789012345678`");
        }
        const vanityUrl = args[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        const targetGuildId = args[1];
        if (!vanityUrl || vanityUrl.length < 2) {
            return message.reply("Please provide a valid vanity URL (letters, numbers, and hyphens only).");
        }
        if (!/^\d{17,19}$/.test(targetGuildId)) {
            return message.reply("Please provide a valid guild ID (17-19 digits).");
        }
        const targetGuild = this.client.guilds.cache.get(targetGuildId);
        if (!targetGuild) {
            return message.reply(`I'm not in the server with ID: **${targetGuildId}**. Please make sure the bot is added to that server.`);
        }
        const botMember = targetGuild.members.cache.get(this.client.user.id);
        if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return message.reply(`I don't have **Manage Server** permissions in **${targetGuild.name}**. Please grant me the necessary permissions.`);
        }
        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        const existingEntry = this.autoSwapVanities.get(vanityKey);
        if (existingEntry && existingEntry.userId === message.author.id) {
            return message.reply(`You already have auto swap enabled for vanity: **${vanityUrl}**`);
        }
        this.autoSwapVanities.set(vanityKey, {
            userId: message.author.id,
            channelId: message.channel.id,
            guildId: guildId,
            vanityUrl: vanityUrl,
            targetGuildId: targetGuildId,
            targetGuildName: targetGuild.name,
            addedAt: Date.now(),
        });
        await this.saveAutoSwapData();
        const embed = new EmbedBuilder()
            .setColor("#ff6600")
            .setTitle("⚡ Auto Swap Enabled")
            .setDescription(`Auto swap configured for **${vanityUrl}**`)
            .addFields(
                { name: "Vanity URL", value: `discord.gg/${vanityUrl}`, inline: true },
                { name: "Target Server", value: targetGuild.name, inline: true },
            )
            .setFooter({ text: "Will automatically claim when available" })
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async handleRemoveAutoSwapCommand(message, args) {
        if (!args[0]) {
            return message.reply("Usage: `,removeautoswap <vanity_url>`");
        }
        const vanityUrl = args[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        const entry = this.autoSwapVanities.get(vanityKey);
        if (!entry || entry.userId !== message.author.id) {
            return message.reply(`You don't have auto swap enabled for: **${vanityUrl}**`);
        }
        this.autoSwapVanities.delete(vanityKey);
        await this.saveAutoSwapData();
        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ Auto Swap Removed")
            .setDescription(`Stopped auto swap for **${vanityUrl}**`)
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async handleListAutoSwapCommand(message) {
        const guildId = message.guild?.id || "dm";
        const userAutoSwaps = Array.from(this.autoSwapVanities.entries()).filter(
            ([key, data]) => {
                const [keyGuildId] = key.split('_');
                return keyGuildId === guildId && data.userId === message.author.id;
            }
        );
        if (userAutoSwaps.length === 0) {
            return message.reply("You don't have any auto swaps configured in this server. Use `,autoswap <vanity> <guild_id>` to set one up.");
        }
        const embed = new EmbedBuilder()
            .setColor("#ff6600")
            .setTitle("⚡ Your Auto Swap Configuration")
            .setDescription(userAutoSwaps.map(([key, data]) => `• **${data.vanityUrl}** → ${data.targetGuildName}`).join("\n"))
            .setFooter({ text: `Total: ${userAutoSwaps.length} auto swap${userAutoSwaps.length === 1 ? "" : "s"} in this server` })
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async handleHelpCommand(message) {
        const embed = new EmbedBuilder()
            .setColor("#7289da")
            .setTitle("🤖 Vanity Monitor Bot Commands")
            .setDescription([
                "``,add <vanity_url>`` — Monitor a vanity URL",
                "``,remove <vanity_url>`` — Stop monitoring a vanity URL",
                "``,list`` — List your monitored vanities",
                "``,autoswap <vanity_url> <guild_id>`` — Auto-claim a vanity for a server",
                "``,removeautoswap <vanity_url>`` — Remove an auto swap",
                "``,listautoswap`` — List your auto swaps",
                "``,help`` — Show this help message"
            ].join("\n"))
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    async checkVanityExists(vanityUrl) {
        try {
            const proxyAgent = this.createProxyAgent();
            const config = {
                method: 'GET',
                timeout: 10000,
            };
            if (proxyAgent) config.httpsAgent = proxyAgent;
            await axios.get(`https://discord.com/api/v10/invites/${vanityUrl}`, config);
            return true; // Exists
        } catch (error) {
            if (error.response && error.response.status === 404) {
                return false; // Not found
            }
            return true; // Treat as exists on error
        }
    }

    async claimVanity(vanityUrl, targetGuildId) {
        try {
            const targetGuild = this.client.guilds.cache.get(targetGuildId);
            if (!targetGuild) throw new Error(`Bot not in target guild ${targetGuildId}`);
            const botMember = targetGuild.members.cache.get(this.client.user.id);
            if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                throw new Error(`No manage guild permissions in ${targetGuild.name}`);
            }
            const proxyAgent = this.createProxyAgent();
            const config = {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bot ${this.client.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10000,
            };
            if (proxyAgent) config.httpsAgent = proxyAgent;
            const response = await axios.patch(
                `https://discord.com/api/v10/guilds/${targetGuildId}/vanity-url`,
                { code: vanityUrl },
                config
            );
            if (response.status === 200) {
                console.log(`Successfully claimed vanity ${vanityUrl} for guild ${targetGuild.name}`);
                return true;
            } else {
                throw new Error(`API returned status ${response.status}`);
            }
        } catch (error) {
            console.error(`Failed to claim vanity ${vanityUrl}:`, error.message);
            return false;
        }
    }

    async startMonitoring() {
        setInterval(async () => {
            for (const [key, data] of this.monitoredVanities.entries()) {
                const available = !(await this.checkVanityExists(data.vanityUrl));
                if (available) {
                    const channel = await this.client.channels.fetch(data.channelId).catch(() => null);
                    if (channel) {
                        channel.send(`Vanity **${data.vanityUrl}** is now available!`);
                    }
                    this.monitoredVanities.delete(key);
                    await this.saveData();
                }
            }
            for (const [key, data] of this.autoSwapVanities.entries()) {
                const available = !(await this.checkVanityExists(data.vanityUrl));
                if (available) {
                    const success = await this.claimVanity(data.vanityUrl, data.targetGuildId);
                    const channel = await this.client.channels.fetch(data.channelId).catch(() => null);
                    if (channel) {
                        if (success) {
                            channel.send(`Successfully claimed vanity **${data.vanityUrl}** for **${data.targetGuildName}**!`);
                        } else {
                            channel.send(`Failed to claim vanity **${data.vanityUrl}** for **${data.targetGuildName}**.`);
                        }
                    }
                    this.autoSwapVanities.delete(key);
                    await this.saveAutoSwapData();
                }
            }
        }, this.checkInterval);
    }

    async loadData() {
        try {
            const data = await fs.readFile(this.dataFile, "utf8");
            const obj = JSON.parse(data);
            for (const [key, value] of Object.entries(obj)) {
                this.monitoredVanities.set(key, value);
            }
        } catch {
            // Ignore if file doesn't exist
        }
    }

    async saveData() {
        const obj = Object.fromEntries(this.monitoredVanities);
        await fs.writeFile(this.dataFile, JSON.stringify(obj, null, 2));
    }

    async loadAutoSwapData() {
        try {
            const data = await fs.readFile(this.autoSwapDataFile, "utf8");
            const obj = JSON.parse(data);
            for (const [key, value] of Object.entries(obj)) {
                this.autoSwapVanities.set(key, value);
            }
        } catch {
            // Ignore if file doesn't exist
        }
    }

    async saveAutoSwapData() {
        const obj = Object.fromEntries(this.autoSwapVanities);
        await fs.writeFile(this.autoSwapDataFile, JSON.stringify(obj, null, 2));
    }
}

const bot = new VanityMonitorBot();
bot.client.login(process.env.DISCORD_TOKEN);

// Optional: Express server for uptime pings (e.g., for Repl.it)
const app = express();
app.get("/", (req, res) => res.send("Vanity Monitor Bot is running!"));
app.listen(3000, () => console.log("Web server up on port 3000"));
