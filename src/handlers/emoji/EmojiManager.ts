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
                    
                    this.emojiCache.set(emoji.name, emojiInfo);
                    this.emojiIdCache.set(emoji.id, emojiInfo);
                    emojis.push(emojiInfo);
                }
            });
        });

        this.groqHandler.updateEmojiList(emojis);
        logger.debug({ 
            emojiCount: emojis.length,
            nameCache: this.emojiCache.size,
            idCache: this.emojiIdCache.size 
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
        
        const emojiPattern = /(?:<a?:\w+:\d+>)|(?::\w+:)/g;
        
        processedText = processedText.replace(emojiPattern, (match) => {
            if (match.startsWith("<")) {
                const [, animated, name, id] = match.match(/<(a?):([\w]+):(\d+)>/) || [];
                const emojiInfo = this.emojiIdCache.get(id);
                
                if (emojiInfo && emojiInfo.name === name) {
                    return match;
                }
            }
            
            const name = match.replace(/:/g, "");
            const emojiInfo = this.emojiCache.get(name);
            
            if (emojiInfo) {
                return emojiInfo.formatted;
            }
            
            return match;
        });

        return processedText;
    }

    /**
     * Validates if an emoji exists and is accessible
     */
    public validateEmoji(emojiId: string): boolean {
        return this.emojiIdCache.has(emojiId) || this.emojiCache.has(emojiId);
    }

    /**
     * Gets emoji info by name or ID
     */
    public getEmojiInfo(nameOrId: string): EmojiInfo | undefined {
        return this.emojiIdCache.get(nameOrId) || this.emojiCache.get(nameOrId);
    }
} 