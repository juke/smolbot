import { Message } from "discord.js";
import { ChannelCache, CachedMessage } from "../../types";
import { createLogger } from "../../utils/logger";
import { ChannelCacheManager } from "../cache/ChannelCacheManager";
import { ImageProcessor } from "./ImageProcessor";

const logger = createLogger("ContextBuilder");

/**
 * Builds conversation context from cached messages
 */
export class ContextBuilder {
    constructor(
        private cacheManager: ChannelCacheManager,
        private imageProcessor: ImageProcessor
    ) {
        if (!process.env.DISCORD_CLIENT_ID) {
            throw new Error("DISCORD_CLIENT_ID must be set in environment variables");
        }
    }

    /**
     * Builds formatted conversation context
     */
    public async buildContext(
        cache: ChannelCache, 
        currentMessage: Message | null, 
        contextSize = 15,
        excludeCurrentMessage = false
    ): Promise<string> {
        const contextMessages: string[] = [];
        
        // Sort messages by timestamp to ensure chronological order
        let recentMessages = [...cache.messages]
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
            .slice(-contextSize);

        // If there's a current message, ensure it's at the end
        if (currentMessage && !excludeCurrentMessage) {
            // Remove current message if it exists in recent messages
            recentMessages = recentMessages.filter(msg => msg.id !== currentMessage.id);
            
            // Add current message as a cached message format
            const currentCached: CachedMessage = {
                id: currentMessage.id,
                content: currentMessage.content,
                authorId: currentMessage.author.id,
                authorName: currentMessage.member?.displayName || currentMessage.author.username,
                timestamp: currentMessage.createdAt,
                images: [], // Images handled separately
                referencedMessage: currentMessage.reference?.messageId
            };
            
            // Add current message at the end
            recentMessages.push(currentCached);
        }

        // Format all messages
        for (const msg of recentMessages) {
            // Mark only the last message as current
            const isCurrentMessage = msg.id === currentMessage?.id;
            const formattedMessage = await this.formatMessage(msg, currentMessage, isCurrentMessage);
            
            if (isCurrentMessage) {
                contextMessages.push("\n=== Current Message ===");
            }
            contextMessages.push(formattedMessage);
        }

        return contextMessages.join("\n\n");
    }

    /**
     * Formats a single message with proper prefixes and image descriptions
     */
    private async formatMessage(
        msg: CachedMessage, 
        currentMessage: Message | null,
        isCurrentMessage = false
    ): Promise<string> {
        let messageContent = msg.content;

        // Add referenced message content if available
        if (msg.referencedMessage) {
            try {
                const referencedMsg = currentMessage?.reference?.messageId === msg.referencedMessage
                    ? currentMessage
                    : await this.findReferencedMessage(msg.referencedMessage, currentMessage);

                if (referencedMsg) {
                    messageContent = `[Replying to: ${referencedMsg.content}]: ${messageContent}`;
                }
            } catch (error) {
                logger.error({ 
                    error, 
                    referencedMessageId: msg.referencedMessage 
                }, "Failed to fetch referenced message");
                messageContent = `[Replying to unavailable message]: ${msg.content}`;
            }
        }

        // Format user identifier consistently
        const userIdentifier = `<@${msg.authorId}> (${msg.authorName})`;
        const messagePrefix = isCurrentMessage ? ">>> " : "";
        const messageLine = `${userIdentifier}: ${messagePrefix}${messageContent}`;
        
        // Add any image descriptions
        const imageLines = msg.images.map(img => `[Image: ${img.lightAnalysis}]`);
        const formattedMessage = [messageLine, ...imageLines].join("\n");

        // Only log if it's the current message or has images
        if (isCurrentMessage || imageLines.length > 0) {
            logger.debug({ 
                messageId: msg.id,
                isCurrentMessage,
                hasImages: imageLines.length > 0,
                formattedMessage
            }, "Formatted message for context");
        }

        return formattedMessage;
    }

    /**
     * Formats a referenced message with its content and images
     */
    private async formatReferencedMessage(
        referencedMsg: { content: string; images?: { lightAnalysis: string }[]; authorId: string; authorName: string },
        originalContent: string
    ): Promise<string> {
        // Remove extra quotes and simplify the reply format
        let formattedReference = `[Replying to message from user <@${referencedMsg.authorId}> (${referencedMsg.authorName}): ${referencedMsg.content}`;
        
        if (referencedMsg.images?.length) {
            const imageDescriptions = referencedMsg.images
                .map(img => `\n[Image: ${img.lightAnalysis}]`)
                .join("");
            formattedReference += imageDescriptions;
        }

        return `${formattedReference}]: ${originalContent}`;
    }

    /**
     * Finds a referenced message either in cache or by fetching
     */
    private async findReferencedMessage(
        messageId: string,
        currentMessage: Message | null
    ): Promise<{ content: string; images?: { lightAnalysis: string }[]; authorId: string; authorName: string } | null> {
        // First check if it's the current message being referenced
        if (currentMessage?.id === messageId) {
            return {
                content: currentMessage.content,
                authorId: currentMessage.author.id,
                authorName: currentMessage.member?.displayName || currentMessage.author.username,
                images: [] // Current message images handled separately
            };
        }

        // Then check the cache
        const cachedMessage = this.cacheManager.findMessage(messageId);
        if (cachedMessage) {
            return {
                content: cachedMessage.content,
                images: cachedMessage.images,
                authorId: cachedMessage.authorId,
                authorName: cachedMessage.authorName
            };
        }

        // If not in cache and we have current message, try to fetch from Discord
        if (currentMessage) {
            try {
                const fetchedMessage = await currentMessage.channel.messages.fetch(messageId);
                if (fetchedMessage) {
                    // Process any images in the fetched message
                    const images = await this.imageProcessor.processImages(fetchedMessage);
                    
                    return {
                        content: fetchedMessage.content,
                        images,
                        authorId: fetchedMessage.author.id,
                        authorName: fetchedMessage.member?.displayName || fetchedMessage.author.username
                    };
                }
            } catch (error) {
                logger.error({ error, messageId }, "Failed to fetch referenced message from Discord");
            }
        }

        return null;
    }
} 