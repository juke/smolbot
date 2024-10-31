import { Message } from "discord.js";
import { GroqHandler } from "../../groqApi";
import { ImageProcessor } from "./ImageProcessor";
import { ContextBuilder } from "./ContextBuilder";
import { ChannelCacheManager } from "../cache/ChannelCacheManager";
import { ChannelCache, CachedMessage } from "../../types";
import { createLogger } from "../../utils/logger";

const logger = createLogger("BotMentionHandler");

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

        try {
            // Get previous context without the current message
            const previousContext = await this.contextBuilder.buildContext(cache, message, 20, true);
            const detailedAnalysis = await this.getDetailedImageAnalysis(message, cache);
            
            // Format the current message separately
            const currentMessage = {
                content: message.content,
                author: {
                    id: message.author.id,
                    name: message.member?.displayName || message.author.username
                },
                referencedMessage: message.reference?.messageId
            };
            
            // Combine previous context and detailed analysis into a single context string
            const fullContext = `${previousContext}${
                detailedAnalysis ? `\n\n[Detailed Analysis: ${detailedAnalysis}]` : ""
            }`;

            // Log what the bot sees
            logger.info({
                messageId: message.id,
                context: {
                    previousMessages: previousContext,
                    currentMessage: `[User] <@${currentMessage.author.id}> (${currentMessage.author.name}): ${currentMessage.content}`,
                    detailedAnalysis: detailedAnalysis || "No image analysis"
                }
            }, "Bot's view of conversation");
            
            const response = await this.groqHandler.generateResponse(
                currentMessage,
                fullContext
            );

            const botResponse = await message.reply(response);
            
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

        } catch (error) {
            logger.error({ error, messageId: message.id }, "Error handling bot mention");
            await message.reply("I encountered an error while processing your message.");
        }
    }

    /**
     * Gets detailed image analysis from current or referenced message
     */
    private async getDetailedImageAnalysis(message: Message, cache: ChannelCache): Promise<string> {
        // Check for images in the current message first
        if (message.attachments.size > 0) {
            const firstImage = Array.from(message.attachments.values())
                .find(attachment => attachment.contentType?.startsWith("image/"));
            
            if (firstImage) {
                logger.debug({ 
                    messageId: message.id,
                    imageUrl: firstImage.url
                }, "Performing detailed analysis on current message image");
                
                return await this.imageProcessor.performDetailedAnalysis(firstImage.url);
            }
        }
        
        // If no images in current message, check referenced message
        if (message.reference) {
            const referencedMessage = cache.messages.find((m: CachedMessage) => m.id === message.reference?.messageId);
            if (referencedMessage?.images.length) {
                logger.debug({ 
                    messageId: message.id,
                    imageUrl: referencedMessage.images[0].url
                }, "Performing detailed analysis on referenced message image");
                
                return await this.imageProcessor.performDetailedAnalysis(
                    referencedMessage.images[0].url
                );
            }
        }

        return "";
    }
} 