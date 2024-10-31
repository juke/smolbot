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
    private readonly cacheManager: ChannelCacheManager;
    private readonly imageProcessor: ImageProcessor;
    private readonly contextBuilder: ContextBuilder;
    private readonly botMentionHandler: BotMentionHandler;
    private readonly intervalHandler: IntervalMessageHandler;
    private readonly emojiManager: EmojiManager;
    private readonly interactionQueue: BotInteractionQueue;

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

        this.intervalHandler = new IntervalMessageHandler(
            groqHandler,
            this.contextBuilder,
            this.cacheManager
        );

        this.emojiManager = new EmojiManager(groqHandler);

        this.interactionQueue = new BotInteractionQueue({
            maxConcurrent: 3,
            minDelayMs: 250
        });

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
                await this.interactionQueue.enqueue(async () => {
                    await this.sendTypingIndicator(message.channel);
                    await this.botMentionHandler.handleMention(message);
                });
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
        const messages = await channel.messages.fetch({ limit: this.cacheManager.getMaxSize() });
        
        for (const message of messages.values()) {
            const images = await this.imageProcessor.processImages(message);
            this.cacheManager.addMessage(channel.id, {
                id: message.id,
                content: message.content,
                authorId: message.author.id,
                authorName: message.member?.displayName || message.author.username,
                timestamp: message.createdAt,
                images,
                referencedMessage: message.reference?.messageId
            });
        }

        // Start interval monitoring for this channel
        this.intervalHandler.startMonitoring(channel);
    }

    // Add method to stop monitoring when needed
    public stopChannelMonitoring(channelId: string): void {
        this.intervalHandler.stopMonitoring(channelId);
    }

    /**
     * Updates emoji cache when needed
     */
    public updateEmojis(client: Client): void {
        this.emojiManager.updateEmojiCache(client);
    }
}

// Add a default export
export default MessageHandler; 