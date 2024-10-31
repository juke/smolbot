import { Client, Message, TextChannel, ChannelType, BaseGuildTextChannel, DMChannel, TextBasedChannel } from "discord.js";
import { GroqHandler } from "../../groqApi";
import { ImageProcessor } from "./ImageProcessor";
import { ContextBuilder } from "./ContextBuilder";
import { BotMentionHandler } from "./BotMentionHandler";
import { ChannelCacheManager } from "../cache/ChannelCacheManager";
import { createLogger } from "../../utils/logger";
import { IntervalMessageHandler } from "./IntervalMessageHandler";
import { EmojiManager } from "../emoji/EmojiManager";
import { BotInteractionQueue } from "./BotInteractionQueue";
import { JsonAdapter } from "../../database/JsonAdapter";
import path from "path";
import fs from "fs/promises";

const logger = createLogger("MessageHandler");

/**
 * Type guard for channels that support typing indicators
 */
type TypingCapableChannel = TextBasedChannel & {
    sendTyping: () => Promise<void>;
};

/**
 * Main message handling coordinator
 */
export class MessageHandler {
    private static instance: MessageHandler;
    private readonly processingMessages: Set<string> = new Set();
    private cacheManager!: ChannelCacheManager;
    private imageProcessor!: ImageProcessor;
    private contextBuilder!: ContextBuilder;
    private botMentionHandler!: BotMentionHandler;
    private intervalHandler!: IntervalMessageHandler;
    private emojiManager!: EmojiManager;
    private interactionQueue!: BotInteractionQueue;
    private readonly groqHandler: GroqHandler;
    private initialized = false;

    private constructor(groqHandler: GroqHandler) {
        this.groqHandler = groqHandler;
    }

    public static async initialize(groqHandler: GroqHandler): Promise<MessageHandler> {
        if (!MessageHandler.instance) {
            const instance = new MessageHandler(groqHandler);
            await instance.initializeComponents();
            MessageHandler.instance = instance;
        }
        return MessageHandler.instance;
    }

    public static getInstance(): MessageHandler {
        if (!MessageHandler.instance || !MessageHandler.instance.initialized) {
            throw new Error("MessageHandler not initialized. Call initialize() first");
        }
        return MessageHandler.instance;
    }

    /**
     * Initializes all components
     */
    private async initializeComponents(): Promise<void> {
        try {
            const dataDir = path.join(__dirname, "../../../data");
            await fs.mkdir(dataDir, { recursive: true });
            
            const database = new JsonAdapter(dataDir);
            await database.initialize();
            
            // Initialize components
            this.cacheManager = new ChannelCacheManager({ maxSize: 20 }, database);
            this.imageProcessor = new ImageProcessor(this.groqHandler);
            this.contextBuilder = new ContextBuilder(this.cacheManager, this.imageProcessor);
            this.botMentionHandler = new BotMentionHandler(
                this.groqHandler,
                this.imageProcessor,
                this.contextBuilder,
                this.cacheManager
            );
            this.intervalHandler = new IntervalMessageHandler(
                this.groqHandler,
                this.contextBuilder,
                this.cacheManager
            );
            this.emojiManager = new EmojiManager();
            this.interactionQueue = new BotInteractionQueue({
                minDelayMs: 2000
            });

            this.initialized = true;
            logger.info("MessageHandler initialized successfully");
        } catch (error) {
            logger.error({ error }, "Failed to initialize MessageHandler");
            throw error;
        }
    }

    /**
     * Main message handling entry point
     */
    public async handleMessage(client: Client, message: Message): Promise<void> {
        const messageId = message.id;
        
        // Skip if already processing
        if (this.processingMessages.has(messageId)) {
            return;
        }
        
        try {
            this.processingMessages.add(messageId);
            
            // Initialize cache for this channel if needed
            if (message.channel.type === ChannelType.GuildText) {
                await this.initializeCache(message.channelId, message.channel);
            }
            
            // Process the message
            await this.processMessage(client, message);
            
        } catch (error) {
            logger.error({ error, messageId }, "Error in handleMessage");
        } finally {
            this.processingMessages.delete(messageId);
        }
    }

    /**
     * Checks if a channel supports typing indicators
     */
    private canShowTyping(channel: TextBasedChannel): channel is TypingCapableChannel {
        return typeof (channel as TypingCapableChannel).sendTyping === "function";
    }

    /**
     * Safely sends typing indicator if supported
     */
    private async sendTypingIndicator(channel: TextBasedChannel): Promise<void> {
        if (this.canShowTyping(channel)) {
            try {
                await channel.sendTyping();
            } catch (error) {
                logger.warn({ error, channelId: channel.id }, "Failed to send typing indicator");
            }
        }
    }

    /**
     * Processes an incoming message
     */
    private async processMessage(client: Client, message: Message): Promise<void> {
        // Skip if message is from the bot itself
        if (message.author.id === client.user?.id) {
            return;
        }

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

            // Cache all messages first
            await this.processNormalMessage(message);

            // Check if message is a bot interaction
            const isMentioned = message.mentions.users.has(client.user?.id ?? "");
            const isReplyToBot = message.reference?.messageId && 
                (await message.channel.messages.fetch(message.reference.messageId))
                    .author.id === client.user?.id;

            // Then handle bot interactions if needed
            if (isMentioned || isReplyToBot) {
                await this.interactionQueue.enqueue(
                    async () => {
                        await this.botMentionHandler.handleMention(message);
                    },
                    message.channel,
                    1
                );
            }
        } catch (error) {
            logger.error({ error, messageId }, "Error in processMessage");
        } finally {
            this.processingMessages.delete(messageId);
        }
    }

    /**
     * Processes a normal message (no bot interaction)
     */
    private async processNormalMessage(message: Message): Promise<void> {
        // Process images and cache the message
        const images = await this.imageProcessor.processImages(message);
        this.cacheManager.addMessage(message.channelId, {
            id: message.id,
            content: message.content,
            authorId: message.author.id,
            authorName: message.member?.displayName || message.author.username,
            timestamp: message.createdAt,
            images,
            referencedMessage: message.reference?.messageId
        });
    }

    /**
     * Initializes the cache for a channel
     */
    private async initializeCache(channelId: string, channel: TextChannel): Promise<void> {
        logger.info({ channelId }, "Initializing channel cache");
        
        // Check if we already have this channel's cache
        const existingCache = this.cacheManager.getCache(channelId);
        if (existingCache) {
            logger.debug({ channelId }, "Cache already exists, skipping initialization");
            return;
        }
        
        // First try to load from database
        await this.cacheManager.loadCache(channelId);
        
        // If cache is still empty or outdated, fetch from Discord
        const cache = this.cacheManager.getCache(channelId);
        if (!cache || cache.messages.length < this.cacheManager.getMaxSize()) {
            logger.info({ channelId }, "Fetching historical messages");
            const messages = await channel.messages.fetch({ 
                limit: this.cacheManager.getMaxSize() 
            });
            
            for (const message of messages.values()) {
                const images = await this.imageProcessor.processImages(message);
                await this.cacheManager.addMessage(channelId, {
                    id: message.id,
                    content: message.content,
                    authorId: message.author.id,
                    authorName: message.member?.displayName || message.author.username,
                    timestamp: message.createdAt,
                    images,
                    referencedMessage: message.reference?.messageId
                });
            }
        }

        // Start interval monitoring for this channel
        this.intervalHandler.startMonitoring(channel);
    }

    // Add method to stop monitoring when needed
    public stopChannelMonitoring(channelId: string): void {
        this.intervalHandler.stopMonitoring(channelId);
    }

    /**
     * Updates emoji cache and refreshes system message
     */
    public async updateEmojis(client: Client): Promise<void> {
        this.emojiManager.updateEmojiCache(client);
        this.groqHandler.updateEmojiList(client);
        logger.info("Emoji cache updated");
    }

    /**
     * Cleans up resources before shutdown
     */
    public async cleanup(): Promise<void> {
        try {
            // Stop all interval monitoring
            for (const channel of this.intervalHandler.getMonitoredChannels()) {
                this.stopChannelMonitoring(channel);
            }

            // Cleanup cache manager
            await this.cacheManager.cleanup();

            logger.info("Successfully cleaned up resources");
        } catch (error) {
            logger.error({ error }, "Error during cleanup");
        }
    }
}

// Add a default export
export default MessageHandler; 