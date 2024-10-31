// src/types.ts
/**
 * Represents the analysis results for an image
 */
interface ImageAnalysis {
    lightAnalysis: string;
    detailedAnalysis?: string;
    url: string;
}

/**
 * Represents a cached message with its associated data
 */
interface CachedMessage {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    timestamp: Date;
    images: ImageAnalysis[];
    referencedMessage?: string;
}

/**
 * Represents the message cache for a channel
 */
interface ChannelCache {
    messages: CachedMessage[];
    lastMessageId?: string;
}

/**
 * Represents a Discord emoji with its formatting information
 */
interface EmojiInfo {
    name: string;
    id: string;
    formatted: string;
    isAnimated: boolean;
}

export type { ImageAnalysis, CachedMessage, ChannelCache, EmojiInfo };
  