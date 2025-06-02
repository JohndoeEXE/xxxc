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
const proxies = require("./proxies.js");

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
        
        // Load proxies from file
        this.proxies = proxies || [];
        this.currentProxyIndex = 0;

        console.log(`Loaded ${this.proxies.length} proxies from proxies.js`);

        this.setupEventHandlers();
        this.loadData();
        this.loadAutoSwapData();
    }

    getRandomProxy() {
        if (this.proxies.length === 0) return null;
        
        const proxy = this.proxies[this.currentProxyIndex];
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
        
        const [host, port, username, password] = proxy.split(':');
        return {
            host,
            port: parseInt(port),
            auth: `${username}:${password}`
        };
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

            const args = message.content.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            if (message.content.startsWith(",add")) {
                await this.handleAddCommand(message, args);
            } else if (message.content.startsWith(",remove")) {
                await this.handleRemoveCommand(message, args);
            } else if (message.content.startsWith(",list")) {
                await this.handleListCommand(message);
            } else if (message.content.startsWith(",autoswap")) {
                await this.handleAutoSwapCommand(message, args);
            } else if (message.content.startsWith(",removeautoswap")) {
                await this.handleRemoveAutoSwapCommand(message, args);
            } else if (message.content.startsWith(",listautoswap")) {
                await this.handleListAutoSwapCommand(message);
            } else if (message.content.startsWith(",help")) {
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
                    .setDescription("This bot was made by oxy @bored_vampire on discord and @adose on telegram")
                    .addFields(
                        {
                            name: "Get Started",
                            value: "Use `,help` to see all available commands",
                            inline: false,
                        }
                    )
                    .setTimestamp();

                await channel.send({ embeds: [embed] });
                console.log(`Sent credits message to ${guild.name}`);
            }
        } catch (error) {
            console.error(`Failed to send credits message to ${guild.name}:`, error.message);
        }
    }

    async handleAddCommand(message, args) {
        if (args.length < 2 || args[0] !== "vanity") {
            return message.reply(
                "Usage: `,add vanity <vanity_url>`\nExample: `,add vanity discord-developers`",
            );
        }

        const vanityUrl = args[1].toLowerCase().replace(/[^a-z0-9-]/g, "");

        if (!vanityUrl || vanityUrl.length < 2) {
            return message.reply(
                "Please provide a valid vanity URL (letters, numbers, and hyphens only).",
            );
        }

        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        
        const existingEntry = this.monitoredVanities.get(vanityKey);
        if (existingEntry && existingEntry.userId === message.author.id) {
            return message.reply(
                `You are already monitoring the vanity: **${vanityUrl}**`,
            );
        }

        const vanityExists = await this.checkVanityExists(vanityUrl);
        if (!vanityExists) {
            return message.reply(
                `The vanity **${vanityUrl}** is currently available! You can claim it now.`,
            );
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
            .addFields(
                {
                    name: "Vanity URL",
                    value: `discord.gg/${vanityUrl}`,
                    inline: true,
                },
                { name: "Status", value: "Currently taken", inline: true },
            )
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async handleAutoSwapCommand(message, args) {
        if (args.length < 2) {
            return message.reply(
                "Usage: `,autoswap <vanity_url> <target_guild_id>`\nExample: `,autoswap cool-server 123456789012345678`",
            );
        }

        const vanityUrl = args[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        const targetGuildId = args[1];

        if (!vanityUrl || vanityUrl.length < 2) {
            return message.reply(
                "Please provide a valid vanity URL (letters, numbers, and hyphens only).",
            );
        }

        
        if (!/^\d{17,19}$/.test(targetGuildId)) {
            return message.reply(
                "Please provide a valid guild ID (17-19 digits).",
            );
        }

        
        const targetGuild = this.client.guilds.cache.get(targetGuildId);
        if (!targetGuild) {
            return message.reply(
                `I'm not in the server with ID: **${targetGuildId}**. Please make sure the bot is added to that server.`,
            );
        }

        
        const botMember = targetGuild.members.cache.get(this.client.user.id);
        if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return message.reply(
                `I don't have **Manage Server** permissions in **${targetGuild.name}**. Please grant me the necessary permissions.`,
            );
        }

        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        
        const existingEntry = this.autoSwapVanities.get(vanityKey);
        if (existingEntry && existingEntry.userId === message.author.id) {
            return message.reply(
                `You already have auto swap enabled for vanity: **${vanityUrl}** → **${targetGuild.name}**`,
            );
        }

        const vanityExists = await this.checkVanityExists(vanityUrl);
        if (!vanityExists) {
            return message.reply(
                `The vanity **${vanityUrl}** is currently available! You can claim it now manually.`,
            );
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
                {
                    name: "Target Server",
                    value: `${targetGuild.name} (${targetGuildId})`,
                    inline: false,
                },
                {
                    name: "Vanity URL",
                    value: `discord.gg/${vanityUrl}`,
                    inline: true,
                },
                { 
                    name: "Status", 
                    value: "Will auto-claim when available", 
                    inline: true 
                },
            )
            .setFooter({
                text: "The vanity will be automatically claimed and set on your server when it becomes available"
            })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async handleRemoveAutoSwapCommand(message, args) {
        if (args.length < 1) {
            return message.reply("Usage: `,removeautoswap <vanity_url>`");
        }

        const vanityUrl = args[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        
        const entry = this.autoSwapVanities.get(vanityKey);

        if (!entry || entry.userId !== message.author.id) {
            return message.reply(
                `You don't have auto swap enabled for vanity: **${vanityUrl}**`,
            );
        }

        this.autoSwapVanities.delete(vanityKey);
        await this.saveAutoSwapData();

        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ Auto Swap Disabled")
            .setDescription(`Auto swap disabled for **${vanityUrl}**`)
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async handleListAutoSwapCommand(message) {
        const guildId = message.guild?.id || "dm";
        
        const userAutoSwaps = Array.from(
            this.autoSwapVanities.entries(),
        ).filter(([key, data]) => {
            const [keyGuildId] = key.split('_');
            return keyGuildId === guildId && data.userId === message.author.id;
        });

        if (userAutoSwaps.length === 0) {
            return message.reply(
                "You don't have any auto swaps configured in this server. Use `,autoswap <vanity> <guild_id>` to set one up.",
            );
        }

        const embed = new EmbedBuilder()
            .setColor("#ff6600")
            .setTitle("⚡ Your Auto Swap Configuration")
            .setDescription(
                userAutoSwaps
                    .map(([key, data]) => `• **${data.vanityUrl}** → ${data.targetGuildName}`)
                    .join("\n"),
            )
            .setFooter({
                text: `Total: ${userAutoSwaps.length} auto swap${userAutoSwaps.length === 1 ? "" : "s"} in this server`,
            })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async handleRemoveCommand(message, args) {
        if (args.length < 2 || args[0] !== "vanity") {
            return message.reply("Usage: `,remove vanity <vanity_url>`");
        }

        const vanityUrl = args[1].toLowerCase().replace(/[^a-z0-9-]/g, "");
        const guildId = message.guild?.id || "dm";
        const vanityKey = `${guildId}_${vanityUrl}`;
        
        const entry = this.monitoredVanities.get(vanityKey);

        if (!entry || entry.userId !== message.author.id) {
            return message.reply(
                `You are not monitoring the vanity: **${vanityUrl}**`,
            );
        }

        this.monitoredVanities.delete(vanityKey);
        await this.saveData();

        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ Vanity Removed from Monitor")
            .setDescription(`Stopped monitoring **${vanityUrl}**`)
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async handleListCommand(message) {
        const guildId = message.guild?.id || "dm";
        
        const userVanities = Array.from(
            this.monitoredVanities.entries(),
        ).filter(([key, data]) => {
            const [keyGuildId] = key.split('_');
            return keyGuildId === guildId && data.userId === message.author.id;
        });

        if (userVanities.length === 0) {
            return message.reply(
                "You are not monitoring any vanities in this server. Use `,add vanity <vanity_url>` to start monitoring.",
            );
        }

        const embed = new EmbedBuilder()
            .setColor("#0099ff")
            .setTitle("📋 Your Monitored Vanities")
            .setDescription(
                userVanities
                    .map(([key, data]) => `• discord.gg/${data.vanityUrl}`)
                    .join("\n"),
            )
            .setFooter({
                text: `Total: ${userVanities.length} vanit${userVanities.length === 1 ? "y" : "ies"} in this server`,
            })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async handleHelpCommand(message) {
        const embed = new EmbedBuilder()
            .setColor("#7289da")
            .setTitle("🤖 Vanity Monitor Bot - Help")
            .setDescription(
                "Monitor Discord server vanities and get notified when they become available!\n\n**This bot was made by oxy @bored_vampire on discord and @adose on telegram**",
            )
            .addFields(
                {
                    name: "**Monitoring Commands**",
                    value: "`,add vanity <vanity_url>` - Add a vanity to monitor\n`,remove vanity <vanity_url>` - Remove a vanity from monitoring\n`,list` - List all vanities you are monitoring",
                    inline: false,
                },
                {
                    name: "**Auto Swap Commands**",
                    value: "`,autoswap <vanity_url> <guild_id>` - Auto-claim vanity for your server\n`,removeautoswap <vanity_url>` - Disable auto swap for a vanity\n`,listautoswap` - List your auto swap configurations",
                    inline: false,
                },
                {
                    name: "**Other Commands**",
                    value: "`,help` - Show this help message",
                    inline: false,
                },
                {
                    name: "**Examples**",
                    value: "`,add vanity cool-server`\n`,autoswap discord-devs 123456789012345678`\n`,removeautoswap cool-server`",
                    inline: false,
                },
            )
            .setFooter({ text: "Checks every 30 seconds • Auto swap instantly claims available vanities" })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    async checkVanityExists(vanityUrl) {
        try {
            const proxyAgent = this.createProxyAgent();
            const config = {
                timeout: 5000,
            };
            
            if (proxyAgent) {
                config.httpsAgent = proxyAgent;
            }

            const response = await axios.get(
                `https://discord.com/api/v10/invites/${vanityUrl}`,
                config
            );
            return response.status === 200;
        } catch (error) {
            if (
                error.response?.status === 404 ||
                error.response?.data?.code === 10006
            ) {
                return false;
            }

            console.log(`Error checking vanity ${vanityUrl}:`, error.message);
            return true;
        }
    }

    async claimVanity(vanityUrl, targetGuildId) {
        try {
            const targetGuild = this.client.guilds.cache.get(targetGuildId);
            if (!targetGuild) {
                throw new Error(`Bot not in target guild ${targetGuildId}`);
            }

            
            await targetGuild.setVanityCode(vanityUrl);
            
            console.log(`Successfully claimed vanity ${vanityUrl} for guild ${targetGuild.name}`);
            return true;
        } catch (error) {
            console.error(`Failed to claim vanity ${vanityUrl}:`, error.message);
            return false;
        }
    }

    startMonitoring() {
        console.log("Starting vanity monitoring...");

        setInterval(async () => {
            
            for (const [vanityKey, data] of this.monitoredVanities.entries()) {
                try {
                    const exists = await this.checkVanityExists(data.vanityUrl);

                    if (!exists) {
                        await this.notifyVanityAvailable(data.vanityUrl, data);
                        this.monitoredVanities.delete(vanityKey);
                        await this.saveData();
                    }
                } catch (error) {
                    console.error(
                        `Error monitoring vanity ${data.vanityUrl}:`,
                        error.message,
                    );
                }
            }

            
            for (const [vanityKey, data] of this.autoSwapVanities.entries()) {
                try {
                    const exists = await this.checkVanityExists(data.vanityUrl);

                    if (!exists) {
                        console.log(`Vanity ${data.vanityUrl} is available! Attempting auto swap...`);
                        
                        const success = await this.claimVanity(data.vanityUrl, data.targetGuildId);
                        
                        if (success) {
                            await this.notifyAutoSwapSuccess(data.vanityUrl, data);
                        } else {
                            await this.notifyAutoSwapFailed(data.vanityUrl, data);
                        }
                        
                        
                        this.autoSwapVanities.delete(vanityKey);
                        await this.saveAutoSwapData();
                    }
                } catch (error) {
                    console.error(
                        `Error monitoring auto swap vanity ${data.vanityUrl}:`,
                        error.message,
                    );
                }
            }
        }, this.checkInterval);
    }

    async notifyVanityAvailable(vanityUrl, data) {
        try {
            const channel = await this.client.channels.fetch(data.channelId);
            const user = await this.client.users.fetch(data.userId);

            const embed = new EmbedBuilder()
                .setColor("#00ff00")
                .setTitle("🎉 Vanity Available!")
                .setDescription(
                    `The vanity **${vanityUrl}** is now available to claim!`,
                )
                .addFields(
                    {
                        name: "Vanity URL",
                        value: `discord.gg/${vanityUrl}`,
                        inline: true,
                    },
                    {
                        name: "Claim it at",
                        value: "Server Settings > Overview > Vanity URL",
                        inline: true,
                    },
                )
                .setFooter({
                    text: "Act fast - vanities can be claimed by anyone!",
                })
                .setTimestamp();

            await channel.send({
                content: `<@${data.userId}>`,
                embeds: [embed],
            });

            console.log(
                `Notified ${user.tag} that vanity ${vanityUrl} is available`,
            );
        } catch (error) {
            console.error(
                `Failed to notify about vanity ${vanityUrl}:`,
                error.message,
            );
        }
    }

    async notifyAutoSwapSuccess(vanityUrl, data) {
        try {
            const channel = await this.client.channels.fetch(data.channelId);
            const user = await this.client.users.fetch(data.userId);
            const targetGuild = this.client.guilds.cache.get(data.targetGuildId);

            const embed = new EmbedBuilder()
                .setColor("#00ff00")
                .setTitle("⚡ Auto Swap Successful!")
                .setDescription(
                    `Successfully claimed vanity **${vanityUrl}** for **${targetGuild.name}**!`,
                )
                .addFields(
                    {
                        name: "New Vanity URL",
                        value: `discord.gg/${vanityUrl}`,
                        inline: true,
                    },
                    {
                        name: "Server",
                        value: targetGuild.name,
                        inline: true,
                    },
                )
                .setFooter({
                    text: "Auto swap completed successfully!",
                })
                .setTimestamp();

            await channel.send({
                content: `<@${data.userId}>`,
                embeds: [embed],
            });

            console.log(
                `Auto swap successful: ${vanityUrl} claimed for ${targetGuild.name}`,
            );
        } catch (error) {
            console.error(
                `Failed to notify auto swap success for ${vanityUrl}:`,
                error.message,
            );
        }
    }

    async notifyAutoSwapFailed(vanityUrl, data) {
        try {
            const channel = await this.client.channels.fetch(data.channelId);
            const user = await this.client.users.fetch(data.userId);

            const embed = new EmbedBuilder()
                .setColor("#ff0000")
                .setTitle("❌ Auto Swap Failed")
                .setDescription(
                    `Failed to claim vanity **${vanityUrl}** automatically. You may need to claim it manually.`,
                )
                .addFields(
                    {
                        name: "Vanity URL",
                        value: `discord.gg/${vanityUrl}`,
                        inline: true,
                    },
                    {
                        name: "Manual Claim",
                        value: "Server Settings > Overview > Vanity URL",
                        inline: true,
                    },
                )
                .setFooter({
                    text: "Auto swap failed - manual action required",
                })
                .setTimestamp();

            await channel.send({
                content: `<@${data.userId}>`,
                embeds: [embed],
            });

            console.log(
                `Auto swap failed for ${vanityUrl}, notified ${user.tag}`,
            );
        } catch (error) {
            console.error(
                `Failed to notify auto swap failure for ${vanityUrl}:`,
                error.message,
            );
        }
    }

    async loadData() {
        try {
            const data = await fs.readFile(this.dataFile, "utf8");
            const parsed = JSON.parse(data);
            
            
            const entries = Object.entries(parsed);
            let needsMigration = false;
            
            for (const [key, value] of entries) {
                
                if (!key.includes('_') || !value.vanityUrl) {
                    needsMigration = true;
                    break;
                }
            }
            
            if (needsMigration) {
                console.log("Migrating data from old format to new server-specific format...");
                const migratedData = new Map();
                
                for (const [oldKey, value] of entries) {
                    
                    if (!oldKey.includes('_')) {
                        const guildId = value.guildId || 'dm';
                        const vanityUrl = oldKey;
                        const newKey = `${guildId}_${vanityUrl}`;
                        
                        migratedData.set(newKey, {
                            ...value,
                            vanityUrl: vanityUrl
                        });
                    } else {
                        
                        migratedData.set(oldKey, value);
                    }
                }
                
                this.monitoredVanities = migratedData;
                await this.saveData(); 
                console.log(`Migrated and loaded ${this.monitoredVanities.size} monitored vanities`);
            } else {
                
                this.monitoredVanities = new Map(entries);
                console.log(`Loaded ${this.monitoredVanities.size} monitored vanities`);
            }
        } catch (error) {
            console.log("No existing data file found, starting fresh");
        }
    }

    async loadAutoSwapData() {
        try {
            const data = await fs.readFile(this.autoSwapDataFile, "utf8");
            const parsed = JSON.parse(data);
            this.autoSwapVanities = new Map(Object.entries(parsed));
            console.log(`Loaded ${this.autoSwapVanities.size} auto swap configurations`);
        } catch (error) {
            console.log("No existing auto swap data file found, starting fresh");
        }
    }

    async saveData() {
        try {
            const dataObj = Object.fromEntries(this.monitoredVanities);
            await fs.writeFile(this.dataFile, JSON.stringify(dataObj, null, 2));
        } catch (error) {
            console.error("Failed to save data:", error.message);
        }
    }

    async saveAutoSwapData() {
        try {
            const dataObj = Object.fromEntries(this.autoSwapVanities);
            await fs.writeFile(this.autoSwapDataFile, JSON.stringify(dataObj, null, 2));
        } catch (error) {
            console.error("Failed to save auto swap data:", error.message);
        }
    }

    start(token) {
        this.client.login(token);
    }
}

const bot = new VanityMonitorBot();

const BOT_TOKEN = 
    process.env.BOT_TOKEN ||
    "MTM3ODc4ODIyMjIxMzI5NjE3OQ.GrZgaF.Dsbs6EsMqXXz31adoACrW1NdTYbWBWyjtvYe1M";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.json({
        status: "online",
        uptime: process.uptime(),
        monitored_vanities: bot.monitoredVanities.size,
        auto_swap_vanities: bot.autoSwapVanities.size,
    });
});

app.listen(port, () => {
    console.log(`Keep-alive server running on port ${port}`);
});

bot.start(BOT_TOKEN);

process.on("SIGINT", async () => {
    console.log("Shutting down...");
    await bot.saveData();
    await bot.saveAutoSwapData();
    process.exit(0);
});

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(1);
});
