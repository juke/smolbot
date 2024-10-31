import { Message, TextBasedChannel } from "discord.js";
import { GroqHandler } from "../../groqApi";
import { ImageProcessor } from "./ImageProcessor";
import { ContextBuilder } from "./ContextBuilder";
import { ChannelCacheManager } from "../cache/ChannelCacheManager";
import { ChannelCache } from "../../types";
import { createLogger } from "../../utils/logger";

const logger = createLogger("BotMentionHandler");

/**
 * Type for channels that support typing indicators
 */
type TypingCapableChannel = TextBasedChannel & {
    sendTyping: () => Promise<void>;
};

/**
 * Handles bot mention interactions
 */
export class BotMentionHandler {
    constructor(
        private groqHandler: GroqHandler,
        private imageProcessor: ImageProcessor,
        private contextBuilder: ContextBuilder,
        private cacheManager: ChannelCacheManager
    ) {}

    /**
     * Processes a message where the bot is mentioned
     */
    public async handleMention(message: Message): Promise<void> {
        const startTime = Date.now();
        const cache = this.cacheManager.getCache(message.channelId);

        if (!cache) {
            logger.debug({ messageId: message.id }, "No cache found for channel");
            return;
        }

        // Define timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error("Response generation timed out"));
            }, 30000); // 30 second timeout
        });

        try {
            // Get context and analysis before starting typing
            const previousContext = await this.contextBuilder.buildContext(cache, message, 20, true);
            
            // Log context details at debug level
            logger.debug({ 
                messageId: message.id,
                contextLength: previousContext.length,
                cacheSize: cache.messages.length,
                hasContext: previousContext.length > 0
            }, "Built context for message");

            const detailedAnalysis = await this.getDetailedImageAnalysis(message, cache);
            
            // Format the current message
            const currentMessage = {
                content: message.content,
                author: {
                    id: message.author.id,
                    name: message.member?.displayName || message.author.username
                },
                referencedMessage: message.reference?.messageId
            };
            
            const fullContext = `${previousContext}${
                detailedAnalysis ? `\n\n[Detailed Analysis: ${detailedAnalysis}]` : ""
            }`;

            // Log full context details at debug level
            logger.debug({ 
                messageId: message.id,
                fullContextLength: fullContext.length,
                hasAnalysis: !!detailedAnalysis
            }, "Prepared full context for response generation");

            // Start typing just before generating response
            const typingInterval = this.startTypingInterval(message.channel);
            
            try {
                // Race between response generation and timeout
                const response = await Promise.race([
                    this.groqHandler.generateResponse(currentMessage, fullContext),
                    timeoutPromise
                ]) as string;

                // Clear typing before sending response
                clearInterval(typingInterval);
                const botResponse = await message.reply({ content: response });
                
                // Process and cache the bot's response
                const images = await this.imageProcessor.processImages(botResponse);
                this.cacheManager.addMessage(message.channelId, {
                    id: botResponse.id,
                    content: botResponse.content,
                    authorId: botResponse.author.id,
                    authorName: botResponse.author.username,
                    timestamp: botResponse.createdAt,
                    images,
                    referencedMessage: botResponse.reference?.messageId
                });

                const duration = Date.now() - startTime;
                logger.info({ duration, messageId: message.id }, "Message handling completed");

            } catch (error) {
                clearInterval(typingInterval);
                throw error;
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            logger.error({ error, duration, messageId: message.id }, "Error handling bot mention");
            
            if (errorMessage === "Response generation timed out") {
                await message.reply({ 
                    content: "sorry fren, im taking too long to think rn :sadge: try again in a bit" 
                });
            } else {
                await message.reply({ 
                    content: "I encountered an error while processing your message." 
                });
            }
        }
    }

    /**
     * Starts a typing indicator interval that continues until cleared
     * @returns NodeJS.Timeout that can be cleared to stop typing
     */
    private startTypingInterval(channel: TextBasedChannel): NodeJS.Timeout {
        // Send initial typing indicator
        if (this.canShowTyping(channel)) {
            void channel.sendTyping().catch((error: Error) => {
                logger.warn({ error, channelId: channel.id }, "Failed to send typing indicator");
            });
        }

        // Continue showing typing every 5 seconds instead of 8
        // Discord's typing timeout is 10 seconds, so this gives better visual feedback
        return setInterval(() => {
            if (this.canShowTyping(channel)) {
                void channel.sendTyping().catch((error: Error) => {
                    logger.warn({ error, channelId: channel.id }, "Failed to send typing indicator");
                });
            }
        }, 5000);
    }

    /**
     * Type guard for channels that support typing indicators
     */
    private canShowTyping(channel: TextBasedChannel): channel is TypingCapableChannel {
        return 'sendTyping' in channel;
    }

    /**
     * Gets detailed image analysis from current or referenced message
     */
    private async getDetailedImageAnalysis(message: Message, cache: ChannelCache): Promise<string> {
        let analysis = "";

        // Check for images in the current message first
        if (message.attachments.size > 0) {
            const firstImage = Array.from(message.attachments.values())
                .find(attachment => attachment.contentType?.startsWith("image/"));
            
            if (firstImage) {
                logger.debug({ 
                    messageId: message.id,
                    imageUrl: firstImage.url
                }, "Performing detailed analysis on current message image");
                
                analysis = await this.imageProcessor.performDetailedAnalysis(firstImage.url);
            }
        }
        
        // If message is a reply, also check referenced message for images
        if (message.reference) {
            try {
                // First try to find in cache
                const referencedMessage = cache.messages.find(m => m.id === message.reference?.messageId);
                
                if (referencedMessage?.images.length) {
                    logger.debug({ 
                        messageId: message.id,
                        referencedMessageId: message.reference.messageId,
                        imageUrl: referencedMessage.images[0].url
                    }, "Performing detailed analysis on referenced message image");
                    
                    const refAnalysis = await this.imageProcessor.performDetailedAnalysis(
                        referencedMessage.images[0].url
                    );
                    
                    // Combine analyses if both current and referenced messages have images
                    analysis = analysis 
                        ? `Current Image: ${analysis}\nReferenced Image: ${refAnalysis}`
                        : refAnalysis;
                } else {
                    // If not in cache, try to fetch from Discord
                    const fetchedMessage = await message.fetchReference();
                    if (fetchedMessage.attachments.size > 0) {
                        const firstImage = Array.from(fetchedMessage.attachments.values())
                            .find(attachment => attachment.contentType?.startsWith("image/"));
                        
                        if (firstImage) {
                            logger.debug({ 
                                messageId: message.id,
                                referencedMessageId: fetchedMessage.id,
                                imageUrl: firstImage.url
                            }, "Performing detailed analysis on fetched referenced message image");
                            
                            const refAnalysis = await this.imageProcessor.performDetailedAnalysis(firstImage.url);
                            
                            // Combine analyses if both current and referenced messages have images
                            analysis = analysis 
                                ? `Current Image: ${analysis}\nReferenced Image: ${refAnalysis}`
                                : refAnalysis;
                                
                            // Process and cache the referenced message
                            const images = await this.imageProcessor.processImages(fetchedMessage);
                            this.cacheManager.addMessage(message.channelId, {
                                id: fetchedMessage.id,
                                content: fetchedMessage.content,
                                authorId: fetchedMessage.author.id,
                                authorName: fetchedMessage.member?.displayName || fetchedMessage.author.username,
                                timestamp: fetchedMessage.createdAt,
                                images,
                                referencedMessage: fetchedMessage.reference?.messageId
                            });
                        }
                    }
                }
            } catch (error) {
                logger.error({ 
                    error, 
                    messageId: message.id,
                    referencedMessageId: message.reference.messageId 
                }, "Error analyzing referenced message image");
            }
        }

        return analysis;
    }
} 