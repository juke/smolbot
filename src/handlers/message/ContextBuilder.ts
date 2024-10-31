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

        // Handle message references/replies
        if (msg.referencedMessage && currentMessage?.channel) {
            const cache = this.cacheManager.getCache(currentMessage.channelId);
            const referencedMsg = cache?.messages.find(m => m.id === msg.referencedMessage);
            
            if (referencedMsg) {
                messageContent = await this.formatReferencedMessage(referencedMsg, msg.content);
            } else if (currentMessage) {
                // Try to fetch from Discord API if not in cache
                try {
                    const fetchedMessage = await currentMessage.channel.messages.fetch(msg.referencedMessage);
                    if (fetchedMessage) {
                        // Process any images in the fetched message
                        const images = await this.imageProcessor.processImages(fetchedMessage);
                        
                        // Add to cache
                        this.cacheManager.addMessage(currentMessage.channelId, {
                            id: fetchedMessage.id,
                            content: fetchedMessage.content,
                            authorId: fetchedMessage.author.id,
                            authorName: fetchedMessage.member?.displayName || fetchedMessage.author.username,
                            timestamp: fetchedMessage.createdAt,
                            images,
                            referencedMessage: fetchedMessage.reference?.messageId,
                        });

                        // Fix: Include author information when formatting referenced message
                        messageContent = await this.formatReferencedMessage(
                            {
                                content: fetchedMessage.content,
                                images,
                                authorId: fetchedMessage.author.id,
                                authorName: fetchedMessage.member?.displayName || fetchedMessage.author.username
                            },
                            msg.content
                        );
                    }
                } catch (error) {
                    logger.error({ 
                        error, 
                        referencedMessageId: msg.referencedMessage 
                    }, "Failed to fetch referenced message");
                    messageContent = `[Replying to unavailable message]: ${msg.content}`;
                }
            }
        }

        const botClientId = process.env.DISCORD_CLIENT_ID;
        if (!botClientId) {
            logger.warn("DISCORD_CLIENT_ID not set in environment variables");
        }
        
        const isSmolBot = msg.authorId === botClientId;
        const prefix = isSmolBot ? "[SmolBot]" : "[User]";

        // Format user identifier consistently
        const userIdentifier = `<@${msg.authorId}> (${msg.authorName})`;

        // Add current message marker
        const messagePrefix = isCurrentMessage ? ">>> " : "";
        
        // Format the message line
        const messageLine = `${prefix} ${userIdentifier}: ${messagePrefix}${messageContent}`;
        const imageLines = msg.images.map(img => `[Image: ${img.lightAnalysis}]`);

        return [messageLine, ...imageLines].join("\n");
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
} 