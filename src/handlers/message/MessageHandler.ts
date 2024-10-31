import { Client, Message, TextChannel } from "discord.js";
import { GroqHandler } from "../../groqApi";
import { ImageProcessor } from "./ImageProcessor";
import { ContextBuilder } from "./ContextBuilder";
import { BotMentionHandler } from "./BotMentionHandler";
import { ChannelCacheManager } from "../cache/ChannelCacheManager";
import { createLogger } from "../../utils/logger";

const logger = createLogger("MessageHandler");

/**
 * Main message handling coordinator
 */
export class MessageHandler {
    private static instance: MessageHandler;
    private readonly processingMessages: Set<string> = new Set();
    private readonly cacheManager: ChannelCacheManager;
    private readonly imageProcessor: ImageProcessor;
    private readonly contextBuilder: ContextBuilder;
    private readonly botMentionHandler: BotMentionHandler;

    constructor(groqHandler: GroqHandler) {
        if (MessageHandler.instance) {
            throw new Error("MessageHandler is already instantiated");
        }

        this.cacheManager = new ChannelCacheManager({ maxSize: 20 });
        this.imageProcessor = new ImageProcessor(groqHandler);
        this.contextBuilder = new ContextBuilder(this.cacheManager, this.imageProcessor);
        this.botMentionHandler = new BotMentionHandler(
            groqHandler,
            this.imageProcessor,
            this.contextBuilder,
            this.cacheManager
        );

        MessageHandler.instance = this;
    }

    public static getInstance(): MessageHandler {
        if (!MessageHandler.instance) {
            throw new Error("MessageHandler not initialized");
        }
        return MessageHandler.instance;
    }

    /**
     * Main message handling entry point
     */
    public static async handleMessage(client: Client, message: Message): Promise<void> {
        const instance = MessageHandler.getInstance();
        await instance.processMessage(client, message);
    }

    /**
     * Processes an incoming message
     */
    private async processMessage(client: Client, message: Message): Promise<void> {
        const messageId = message.id;

        // Prevent duplicate processing
        if (this.processingMessages.has(messageId)) {
            logger.debug({ messageId }, "Skipping duplicate message processing");
            return;
        }

        try {
            this.processingMessages.add(messageId);
            logger.debug({ 
                messageId,
                content: message.content,
                author: message.author.username,
                channelId: message.channelId
            }, "Processing new message");

            // Check for !text command
            if (message.content.toLowerCase() === "!text") {
                const cache = this.cacheManager.getCache(message.channelId);
                if (cache) {
                    const context = await this.contextBuilder.buildContext(cache, message);
                    await message.reply(`Here's how I see the conversation:\n\`\`\`\n${context}\n\`\`\``);
                    return;
                }
            }

            // Process images and cache the message
            const images = await this.imageProcessor.processImages(message);
            this.cacheManager.addMessage(message.channelId, {
                id: message.id,
                content: message.content,
                authorId: message.author.id,
                authorName: message.author.username,
                timestamp: message.createdAt,
                images,
                referencedMessage: message.reference?.messageId
            });

            // Check for bot interactions
            const isMentioned = message.mentions.has(client.user!.id);
            const isReplyToBot = message.reference && 
                (await message.fetchReference().catch(() => null))?.author.id === client.user!.id;

            if (isMentioned || isReplyToBot) {
                logger.debug({ messageId, isMentioned, isReplyToBot }, "Bot interaction detected");
                await this.botMentionHandler.handleMention(message);
            }

        } catch (error) {
            logger.error({ error, messageId }, "Error in processMessage");
        } finally {
            this.processingMessages.delete(messageId);
            logger.debug({ messageId }, "Finished processing message");
        }
    }

    /**
     * Initializes the cache for a channel
     */
    public async initializeCache(channel: TextChannel): Promise<void> {
        logger.info({ channelId: channel.id }, "Initializing channel cache");
        const messages = await channel.messages.fetch({ limit: this.cacheManager.getMaxSize() });
        
        for (const message of messages.values()) {
            const images = await this.imageProcessor.processImages(message);
            this.cacheManager.addMessage(channel.id, {
                id: message.id,
                content: message.content,
                authorId: message.author.id,
                authorName: message.author.username,
                timestamp: message.createdAt,
                images,
                referencedMessage: message.reference?.messageId
            });
        }
    }
} 