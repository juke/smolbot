import { Client, GuildEmoji } from "discord.js";
import { createLogger } from "../../utils/logger";
import { EmojiInfo } from "../../types";
import { GroqHandler } from "../../groqApi";

const logger = createLogger("EmojiManager");

/**
 * Manages guild emoji collection and formatting
 */
export class EmojiManager {
    private emojiCache: Map<string, EmojiInfo>;
    private emojiIdCache: Map<string, EmojiInfo>;

    constructor(private groqHandler: GroqHandler) {
        this.emojiCache = new Map();
        this.emojiIdCache = new Map();
    }

    /**
     * Updates emoji cache from all available guilds
     */
    public updateEmojiCache(client: Client): void {
        this.emojiCache.clear();
        this.emojiIdCache.clear();
        const emojis: EmojiInfo[] = [];

        client.guilds.cache.forEach(guild => {
            guild.emojis.cache.forEach((emoji: GuildEmoji) => {
                if (emoji.name) {
                    const emojiInfo: EmojiInfo = {
                        name: emoji.name,
                        id: emoji.id,
                        formatted: this.formatEmoji(emoji),
                        isAnimated: emoji.animated ?? false
                    };
                    
                    const normalizedName = emoji.name.toLowerCase();
                    this.emojiCache.set(normalizedName, emojiInfo);
                    this.emojiIdCache.set(emoji.id, emojiInfo);
                    emojis.push(emojiInfo);
                }
            });
        });

        this.groqHandler.updateEmojiList(emojis);
        logger.debug({ 
            emojiCount: emojis.length,
            nameCache: this.emojiCache.size,
            idCache: this.emojiIdCache.size,
            availableEmojis: emojis.map(e => `${e.name} (${e.formatted})`)
        }, "Updated emoji cache");
    }

    /**
     * Formats a Discord emoji into the proper format
     */
    private formatEmoji(emoji: GuildEmoji): string {
        return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
    }

    /**
     * Replaces emoji names in text with proper Discord emoji format
     */
    public replaceEmojiNames(text: string): string {
        let processedText = text;
        
        // Enhanced pattern to catch all emoji formats including spaced versions
        const emojiPattern = /(?:<a?:[^:]+:\d+>)|(?:\s?:[^:\s]+:\s?)|(?<![@<\w])\b([a-zA-Z0-9_]+)\b(?![@>\w])/g;
        
        processedText = processedText.replace(emojiPattern, (match, bareWord) => {
            // Handle already formatted emojis
            if (match.startsWith("<")) {
                const formatted = match.match(/<(a?):([^:]+):(\d+)>/);
                if (formatted) {
                    const [, , name, id] = formatted;
                    const emojiInfo = this.emojiIdCache.get(id);
                    
                    if (emojiInfo && emojiInfo.name.toLowerCase() === name.toLowerCase()) {
                        return emojiInfo.formatted;
                    }
                }
                return match;
            }
            
            // Handle :emoji: format (now with optional spaces)
            if (match.includes(":")) {
                // Clean up the match by removing spaces and extracting the name
                const name = match.trim().replace(/^:|\s|:$/g, "").toLowerCase();
                const emojiInfo = this.emojiCache.get(name);
                
                if (emojiInfo) {
                    logger.debug({ 
                        originalFormat: match,
                        cleanedName: name,
                        formatted: emojiInfo.formatted
                    }, "Converted :emoji: format to proper format");
                    return emojiInfo.formatted;
                }
                // Only return the original match if it's a properly formatted :emoji:
                return match.trim().match(/^:[^:\s]+:$/) ? match : name;
            }
            
            // Handle bare word format (potential emoji name without colons)
            if (bareWord) {
                const normalizedName = bareWord.toLowerCase();
                const emojiInfo = this.emojiCache.get(normalizedName);
                
                if (emojiInfo) {
                    logger.debug({ 
                        bareWord,
                        normalizedName,
                        formatted: emojiInfo.formatted
                    }, "Converted bare word to emoji");
                    return emojiInfo.formatted;
                }
            }
            
            logger.debug({ 
                match,
                bareWord,
                cacheSize: this.emojiCache.size,
                availableEmojis: Array.from(this.emojiCache.keys())
            }, "Emoji lookup attempt");
            
            return match;
        });

        // Second pass to catch any remaining :emoji: formats that might have been missed
        const remainingEmojiPattern = /:([\w]+):/g;
        processedText = processedText.replace(remainingEmojiPattern, (match, name) => {
            const normalizedName = name.toLowerCase();
            const emojiInfo = this.emojiCache.get(normalizedName);
            
            if (emojiInfo) {
                logger.debug({ 
                    match,
                    normalizedName,
                    formatted: emojiInfo.formatted
                }, "Caught remaining emoji in second pass");
                return emojiInfo.formatted;
            }
            
            return match;
        });

        return processedText;
    }

    /**
     * Validates if an emoji exists and is accessible
     */
    public validateEmoji(nameOrId: string): boolean {
        const normalizedName = nameOrId.toLowerCase();
        return this.emojiIdCache.has(nameOrId) || this.emojiCache.has(normalizedName);
    }

    /**
     * Gets emoji info by name or ID
     */
    public getEmojiInfo(nameOrId: string): EmojiInfo | undefined {
        const normalizedName = nameOrId.toLowerCase();
        return this.emojiIdCache.get(nameOrId) || this.emojiCache.get(normalizedName);
    }
} 