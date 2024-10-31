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

    constructor(private groqHandler: GroqHandler) {
        this.emojiCache = new Map();
    }

    /**
     * Updates emoji cache from all available guilds
     */
    public updateEmojiCache(client: Client): void {
        this.emojiCache.clear();
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
                    emojis.push(emojiInfo);
                }
            });
        });

        // Update the GroqHandler with the new emoji list
        this.groqHandler.updateEmojiList(emojis);

        logger.debug(
            { emojiCount: this.emojiCache.size }, 
            "Updated emoji cache"
        );
    }

    /**
     * Formats a Discord emoji into the proper format
     */
    private formatEmoji(emoji: GuildEmoji): string {
        return emoji.animated 
            ? `<a:${emoji.name}:${emoji.id}>`
            : `<:${emoji.name}:${emoji.id}>`;
    }

    /**
     * Replaces emoji names in text with proper Discord emoji format
     */
    public replaceEmojiNames(text: string): string {
        let processedText = text;
        
        this.emojiCache.forEach((emojiInfo) => {
            // Match :emojiname: pattern
            const pattern = new RegExp(`:${emojiInfo.name}:`, "g");
            processedText = processedText.replace(pattern, emojiInfo.formatted);
        });

        return processedText;
    }
} 