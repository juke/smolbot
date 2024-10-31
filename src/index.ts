// src/index.ts
import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import { createLogger } from "./utils/logger";
import { GroqHandler } from "./groqApi";
import MessageHandler from "./handlers/message/MessageHandler";

config();

const logger = createLogger("Bot");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

const groqHandler = new GroqHandler(process.env.GROQ_API_KEY || "");

// Initialize the MessageHandler only once
if (!MessageHandler['instance']) {
    new MessageHandler(groqHandler);
}

client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}!`);
    
    // Update emoji cache when bot is ready
    MessageHandler.getInstance().updateEmojis(readyClient);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    await MessageHandler.getInstance().handleMessage(client, message);
});

client.login(process.env.DISCORD_TOKEN);
