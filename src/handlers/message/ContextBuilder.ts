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
    ) {}

    /**
     * Builds formatted conversation context
     */
    public async buildContext(
        cache: ChannelCache, 
        currentMessage: Message, 
        contextSize = 5
    ): Promise<string> {
        const contextMessages: string[] = [];
        const recentMessages = cache.messages.slice(-contextSize);
        
        for (const msg of recentMessages) {
            const formattedMessage = await this.formatMessage(msg, currentMessage);
            contextMessages.push(formattedMessage);
        }

        return contextMessages.join("\n\n");
    }

    /**
     * Formats a single message with proper prefixes and image descriptions
     */
    private async formatMessage(msg: CachedMessage, currentMessage: Message): Promise<string> {
        let messageContent = msg.content;

        // Handle message references/replies
        if (msg.referencedMessage) {
            const cache = this.cacheManager.getCache(currentMessage.channelId);
            const referencedMsg = cache?.messages.find(m => m.id === msg.referencedMessage);
            
            if (referencedMsg) {
                messageContent = await this.formatReferencedMessage(referencedMsg, msg.content);
            } else {
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
                            authorName: fetchedMessage.author.username,
                            timestamp: fetchedMessage.createdAt,
                            images,
                            referencedMessage: fetchedMessage.reference?.messageId,
                        });

                        messageContent = await this.formatReferencedMessage(
                            { content: fetchedMessage.content, images },
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

        const botId = currentMessage.client.user?.id;
        const isSmolBot = msg.authorId === botId;
        const isUser = msg.authorId === currentMessage.author.id;
        
        const prefix = isSmolBot ? "[SmolBot]" : 
                      (!isSmolBot && !isUser) ? "[Other Bot]" : 
                      "[User]";

        const messageLine = `${prefix} <@${msg.authorId}> (${msg.authorName}): ${messageContent}`;
        const imageLines = msg.images.map(img => `[Image: ${img.lightAnalysis}]`);

        return [messageLine, ...imageLines].join("\n");
    }

    /**
     * Formats a referenced message with its content and images
     */
    private async formatReferencedMessage(
        referencedMsg: { content: string; images?: { lightAnalysis: string }[] },
        originalContent: string
    ): Promise<string> {
        let formattedReference = `[Replying to message: "${referencedMsg.content}"`;
        
        if (referencedMsg.images?.length) {
            const imageDescriptions = referencedMsg.images
                .map(img => `\n[Image: ${img.lightAnalysis}]`)
                .join("");
            formattedReference += imageDescriptions;
        }

        return `${formattedReference}"]: ${originalContent}`;
    }
} 