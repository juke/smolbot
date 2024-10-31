import { Client, Message, TextChannel } from "discord.js";
import { createLogger } from "./utils/logger";
import { ChannelCache, CachedMessage, ImageAnalysis } from "./types";
import { GroqHandler } from "./groqApi";

const logger = createLogger("MessageHandler");

export class MessageHandler {
    private static instance: MessageHandler;
    private channelCaches: Map<string, ChannelCache>;
    private groqHandler: GroqHandler;
    private readonly CACHE_SIZE = 20;
    private processingMessages: Set<string> = new Set(); // Track messages being processed

    constructor(groqHandler: GroqHandler) {
        if (MessageHandler.instance) {
            logger.error("Attempted to instantiate MessageHandler multiple times.");
            throw new Error("MessageHandler is already instantiated");
        }
        this.channelCaches = new Map();
        this.groqHandler = groqHandler;
        MessageHandler.instance = this;
        logger.debug("MessageHandler initialized");
    }

    public static getInstance(): MessageHandler {
        if (!MessageHandler.instance) {
            throw new Error("MessageHandler not initialized");
        }
        return MessageHandler.instance;
    }

    /**
     * Handles incoming messages
     * @param client Discord client instance
     * @param message The message to handle
     */
    public static async handleMessage(client: Client, message: Message): Promise<void> {
        logger.debug(`handleMessage called for message ID: ${message.id}`);
        const instance = MessageHandler.getInstance();
        const messageId = message.id;

        // Prevent duplicate processing
        if (instance.processingMessages.has(messageId)) {
            logger.debug({ messageId }, "Skipping duplicate message processing");
            return;
        }

        try {
            instance.processingMessages.add(messageId);
            logger.debug({ 
                messageId,
                content: message.content,
                author: message.author.username,
                channelId: message.channelId
            }, "Processing new message");

            // Check for !text command
            if (message.content.toLowerCase() === "!text") {
                const cache = instance.channelCaches.get(message.channelId);
                if (cache) {
                    const context = await instance.buildConversationContext(cache, message);
                    // Format the context in a code block for better readability
                    await message.reply(`Here's how I see the conversation:\n\`\`\`\n${context}\n\`\`\``);
                    return;
                }
            }

            // First, process and cache the message
            await instance.handleNewMessage(message);

            // Check for bot interactions
            const isMentioned = message.mentions.has(client.user!.id);
            const isReplyToBot = message.reference && 
                (await message.fetchReference().catch(() => null))?.author.id === client.user!.id;

            // Only respond once, prioritizing direct mentions
            if (isMentioned || isReplyToBot) {
                logger.debug({ 
                    messageId,
                    isMentioned,
                    isReplyToBot
                }, "Bot interaction detected");
                await instance.handleBotMention(message);
            }

        } catch (error) {
            logger.error({ error, messageId }, "Error in handleMessage");
        } finally {
            instance.processingMessages.delete(messageId);
            logger.debug({ messageId }, "Finished processing message");
        }
    }

    /**
     * Handles messages where the bot is mentioned
     * @param message The message to handle
     */
    private async handleBotMention(message: Message): Promise<void> {
        const startTime = Date.now();
        let currentCache: ChannelCache | undefined;

        try {
            currentCache = this.channelCaches.get(message.channelId);
            if (!currentCache) {
                logger.debug({ messageId: message.id }, "No cache found for channel");
                return;
            }

            // Get conversation context
            const context = await this.buildConversationContext(currentCache, message);
            
            // Handle image analysis for current message and referenced message
            let detailedImageAnalysis = "";
            
            // Check for images in the current message first
            if (message.attachments.size > 0) {
                const firstImage = Array.from(message.attachments.values())
                    .find(attachment => attachment.contentType?.startsWith("image/"));
                
                if (firstImage) {
                    logger.debug({ 
                        messageId: message.id,
                        imageUrl: firstImage.url
                    }, "Performing detailed analysis on current message image");
                    
                    detailedImageAnalysis = await this.groqHandler.performDetailedAnalysis(firstImage.url);
                }
            }
            
            // If no images in current message, check referenced message
            if (!detailedImageAnalysis && message.reference) {
                const referencedMessage = currentCache.messages.find(m => m.id === message.reference?.messageId);
                if (referencedMessage?.images.length) {
                    logger.debug({ 
                        messageId: message.id,
                        imageUrl: referencedMessage.images[0].url
                    }, "Performing detailed analysis on referenced message image");
                    
                    detailedImageAnalysis = await this.groqHandler.performDetailedAnalysis(
                        referencedMessage.images[0].url
                    );
                }
            }

            // Generate response
            logger.debug({ 
                messageId: message.id,
                hasImageAnalysis: !!detailedImageAnalysis
            }, "Generating response");

            const response = await this.groqHandler.generateResponse(
                message.content,
                `${context}\n${detailedImageAnalysis ? `[Detailed Analysis: ${detailedImageAnalysis}]` : ""}`
            );

            // Send the response
            const botResponse = await message.reply(response);
            
            // Cache the bot's response
            await this.processMessage(botResponse, currentCache);
            
            const duration = Date.now() - startTime;
            logger.debug({ 
                messageId: message.id,
                duration,
                responseLength: response.length
            }, "Completed bot mention handler");

        } catch (error) {
            logger.error({ 
                error,
                messageId: message.id,
                duration: Date.now() - startTime
            }, "Error handling bot mention");
            
            const errorResponse = await message.reply("I encountered an error while processing your message.");
            
            // Only cache error response if we have a valid cache
            if (currentCache) {
                await this.processMessage(errorResponse, currentCache);
            }
        }
    }

    /**
     * Builds conversation context from cache
     * @param cache Channel cache
     * @param currentMessage Current message
     */
    private async buildConversationContext(cache: ChannelCache, currentMessage: Message): Promise<string> {
        const contextMessages: string[] = [];
        
        // Get last 5 messages for context
        const recentMessages = cache.messages.slice(-5);
        
        for (const msg of recentMessages) {
            let messageContent = msg.content;
            
            // Handle message references/replies
            if (msg.referencedMessage) {
                const referencedMsg = cache.messages.find(m => m.id === msg.referencedMessage);
                if (referencedMsg) {
                    messageContent = `[Replying to message: "${referencedMsg.content}"]: ${messageContent}`;
                }
            }

            // Format user/bot messages appropriately
            const botId = currentMessage.client.user?.id;
            const isSmolBot = msg.authorId === botId;
            const isUser = msg.authorId === currentMessage.author.id;
            const isOtherBot = !isSmolBot && !isUser;

            // Determine the prefix based on the message author
            const prefix = isSmolBot ? "[SmolBot]" : 
                          isOtherBot ? "[Other Bot]" : 
                          "[User]";

            // Build the message line with Discord mention format
            const messageLine = `${prefix} <@${msg.authorId}> (${msg.authorName}): ${messageContent}`;

            // Add any images with their analysis
            const imageLines = msg.images.map(img => 
                `[Image: ${img.lightAnalysis}]`
            );

            // Combine message and images
            contextMessages.push([messageLine, ...imageLines].join("\n"));
        }

        return contextMessages.join("\n\n");
    }

    /**
     * Initializes the cache for a channel
     * @param channel The Discord channel to initialize cache for
     */
    public async initializeCache(channel: TextChannel): Promise<void> {
        logger.info({ channelId: channel.id }, "Initializing channel cache");
        
        const messages = await channel.messages.fetch({ limit: this.CACHE_SIZE });
        const cache: ChannelCache = {
            messages: [],
            lastMessageId: messages.last()?.id,
        };

        for (const message of messages.values()) {
            await this.processMessage(message, cache);
        }

        this.channelCaches.set(channel.id, cache);
    }

    /**
     * Processes a new message
     * @param message The Discord message to process
     */
    public async handleNewMessage(message: Message): Promise<void> {
        let cache = this.channelCaches.get(message.channelId);
        
        if (!cache) {
            cache = { messages: [] };
            this.channelCaches.set(message.channelId, cache);
        }

        await this.processMessage(message, cache);

        // Maintain cache size
        if (cache.messages.length > this.CACHE_SIZE) {
            cache.messages = cache.messages.slice(-this.CACHE_SIZE);
        }
    }

    /**
     * Processes a message and adds it to the cache
     * @param message The Discord message to process
     * @param cache The channel cache to update
     */
    private async processMessage(message: Message, cache: ChannelCache): Promise<void> {
        const images = await this.processImages(message);
        
        const cachedMessage: CachedMessage = {
            id: message.id,
            content: message.content,
            authorId: message.author.id,
            authorName: message.author.username,
            timestamp: message.createdAt,
            images,
            referencedMessage: message.reference?.messageId,
        };

        cache.messages.push(cachedMessage);
    }

    /**
     * Processes images in a message
     * @param message The Discord message containing images
     * @returns Array of processed images with analysis
     */
    private async processImages(message: Message): Promise<ImageAnalysis[]> {
        const images: ImageAnalysis[] = [];
        
        for (const attachment of message.attachments.values()) {
            if (attachment.contentType?.startsWith("image/")) {
                try {
                    logger.debug({ 
                        messageId: message.id,
                        imageUrl: attachment.url
                    }, "Performing light analysis on message image");
                    
                    const lightAnalysis = await this.groqHandler.performLightAnalysis(attachment.url);
                    
                    images.push({
                        url: attachment.url,
                        lightAnalysis,
                    });
                } catch (error) {
                    logger.error({ 
                        error, 
                        messageId: message.id,
                        imageUrl: attachment.url 
                    }, "Error processing image");
                }
            }
        }

        return images;
    }

    /**
     * Gets the cached messages for a channel
     * @param channelId The ID of the channel
     */
    public getChannelCache(channelId: string): ChannelCache | undefined {
        return this.channelCaches.get(channelId);
    }
}