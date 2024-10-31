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

// Initialize the bot
async function initializeBot(): Promise<void> {
    try {
        // Initialize MessageHandler
        await MessageHandler.initialize(groqHandler);
        const messageHandler = MessageHandler.getInstance();

        client.once(Events.ClientReady, async (readyClient) => {
            logger.info(`Logged in as ${readyClient.user.tag}!`);
            // Update emoji cache and load channel caches when bot is ready
            await messageHandler.updateEmojis(readyClient);
            logger.info("Bot initialization complete");
        });

        client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return;
            await messageHandler.handleMessage(client, message);
        });

        // Cleanup on exit
        process.on("SIGINT", async () => {
            logger.info("Received SIGINT. Cleaning up...");
            await messageHandler.cleanup();
            process.exit(0);
        });

        process.on("SIGTERM", async () => {
            logger.info("Received SIGTERM. Cleaning up...");
            await messageHandler.cleanup();
            process.exit(0);
        });

        // Login to Discord
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        logger.error({ error }, "Failed to initialize bot");
        process.exit(1);
    }
}

// Start the bot
void initializeBot();
