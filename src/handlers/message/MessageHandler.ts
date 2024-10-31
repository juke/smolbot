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
import { SQLiteAdapter } from "../../database/SQLiteAdapter";
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
            
            const dbPath = path.join(dataDir, "cache.db");
            const database = new SQLiteAdapter(dbPath);
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
        await this.processMessage(client, message);
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
     * Initializes the cache for a channel and starts interval monitoring
     */
    public async initializeCache(channel: TextChannel): Promise<void> {
        logger.info({ channelId: channel.id }, "Initializing channel cache");
        
        // First try to load from database
        await this.cacheManager.loadCache(channel.id);
        
        // If cache is empty or outdated, fetch from Discord
        const cache = this.cacheManager.getCache(channel.id);
        if (!cache || cache.messages.length < this.cacheManager.getMaxSize()) {
            const messages = await channel.messages.fetch({ 
                limit: this.cacheManager.getMaxSize() 
            });
            
            for (const message of messages.values()) {
                const images = await this.imageProcessor.processImages(message);
                await this.cacheManager.addMessage(channel.id, {
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
     * Loads caches for all accessible channels
     */
    private async loadAllChannelCaches(client: Client): Promise<void> {
        try {
            const channels = client.channels.cache.filter(
                (channel): channel is TextChannel => 
                    channel.type === ChannelType.GuildText
            );

            logger.info(`Loading caches for ${channels.size} channels`);

            for (const channel of channels.values()) {
                await this.initializeCache(channel);
            }

            logger.info("Successfully loaded all channel caches");
        } catch (error) {
            logger.error({ error }, "Error loading channel caches");
        }
    }

    /**
     * Updates emoji cache and refreshes system message
     */
    public async updateEmojis(client: Client): Promise<void> {
        this.emojiManager.updateEmojiCache(client);
        // Update GroqHandler's emoji list as well
        this.groqHandler.updateEmojiList(client);
        
        // Load all channel caches after emoji cache is updated
        await this.loadAllChannelCaches(client);
        
        logger.info("Emoji cache updated and channel caches loaded");
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