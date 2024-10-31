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
            // Initialize components with in-memory cache only
            this.cacheManager = new ChannelCacheManager({ maxSize: 20 });
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
                minDelayMs: 1500
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
                authorId: message.author.id,
                channelId: message.channelId
            }, "Processing new message");

            // Check if message is a bot interaction
            const isMentioned = message.mentions.users.has(client.user?.id ?? "");
            const isReplyToBot = message.reference?.messageId && 
                (await message.channel.messages.fetch(message.reference.messageId))
                    .author.id === client.user?.id;

            // If this is a bot interaction, ensure cache is initialized first
            if ((isMentioned || isReplyToBot) && message.channel.type === ChannelType.GuildText) {
                await this.initializeCache(message.channel);
            }

            // Cache the current message
            await this.processNormalMessage(message);

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
     * Initializes or completes the cache for a channel
     */
    private async initializeCache(channel: TextChannel): Promise<void> {
        const cache = this.cacheManager.getCache(channel.id);
        const maxSize = this.cacheManager.getMaxSize();
        
        // If cache exists but isn't full, calculate how many more messages we need
        const currentSize = cache?.messages.length ?? 0;
        const messagesNeeded = maxSize - currentSize;
        
        // If cache is already full, no need to fetch more
        if (messagesNeeded <= 0) {
            return;
        }

        logger.info({ 
            channelId: channel.id,
            currentSize,
            fetchingAmount: messagesNeeded 
        }, "Completing channel cache");
        
        // If we have existing messages, use the oldest one as reference
        const oldestMessage = cache?.messages
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
        
        // Fetch messages before the oldest cached message, or just recent messages if cache is empty
        const messages = await channel.messages.fetch({ 
            limit: messagesNeeded,
            ...(oldestMessage && { before: oldestMessage.id })
        });
        
        // Process messages in chronological order
        const sortedMessages = Array.from(messages.values())
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const message of sortedMessages) {
            // Process current message's images
            const images = await this.imageProcessor.processImages(message);
            
            // Handle referenced message if it exists and isn't already cached
            if (message.reference?.messageId) {
                const existingCache = this.cacheManager.getCache(channel.id);
                const isReferencedMessageCached = existingCache?.messages
                    .some(m => m.id === message.reference?.messageId);
                
                if (!isReferencedMessageCached) {
                    try {
                        const referencedMessage = await message.fetchReference();
                        const refImages = await this.imageProcessor.processImages(referencedMessage);
                        
                        await this.cacheManager.addMessage(channel.id, {
                            id: referencedMessage.id,
                            content: referencedMessage.content,
                            authorId: referencedMessage.author.id,
                            authorName: referencedMessage.member?.displayName || referencedMessage.author.username,
                            timestamp: referencedMessage.createdAt,
                            images: refImages,
                            referencedMessage: referencedMessage.reference?.messageId
                        });
                    } catch (error) {
                        logger.warn({ 
                            error, 
                            messageId: message.id,
                            referencedMessageId: message.reference.messageId 
                        }, "Failed to fetch referenced message");
                    }
                }
            }

            // Add the current message to cache
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

        // Start interval monitoring for this channel if not already monitoring
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
        // Update GroqHandler's emoji list as well
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

            logger.info("Successfully cleaned up resources");
        } catch (error) {
            logger.error({ error }, "Error during cleanup");
        }
    }
}

// Add a default export
export default MessageHandler; 