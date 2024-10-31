import { Client } from "discord.js";
import { createLogger } from "../../utils/logger";

const logger = createLogger("EmojiManager");

/**
 * Manages Discord guild emoji formatting and caching
 */
export class EmojiManager {
    // Map emoji names to their Discord formatted versions
    private emojiMap: Map<string, string>;
    // Store just the names for the bot's context
    private availableEmojis: Set<string>;

    constructor() {
        this.emojiMap = new Map();
        this.availableEmojis = new Set();
    }

    /**
     * Updates emoji cache from all available guilds
     */
    public updateEmojiCache(client: Client): void {
        this.emojiMap.clear();
        this.availableEmojis.clear();

        client.guilds.cache.forEach(guild => {
            guild.emojis.cache.forEach(emoji => {
                if (emoji.name) {
                    const name = emoji.name.toLowerCase();
                    // Store Discord's formatted version
                    const formatted = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
                    this.emojiMap.set(name, formatted);
                    // Store just the name for the bot's context
                    this.availableEmojis.add(name);
                }
            });
        });

        logger.debug({ 
            emojiCount: this.emojiMap.size,
            availableEmojis: Array.from(this.availableEmojis)
        }, "Updated emoji cache");
    }

    /**
     * Gets list of available emoji names for bot context
     * Returns simple :emojiname: format
     */
    public getAvailableEmojis(): string[] {
        return Array.from(this.availableEmojis)
            .map(name => `:${name}:`);
    }

    /**
     * Formats message text by replacing :emojiname: with Discord format
     * This happens after the bot generates its response
     */
    public formatText(text: string): string {
        return text.replace(/:(\w+):/g, (match, emojiName) => {
            const formatted = this.emojiMap.get(emojiName.toLowerCase());
            return formatted || match;
        });
    }

    /**
     * Checks if an emoji name is available
     */
    public hasEmoji(name: string): boolean {
        return this.availableEmojis.has(name.toLowerCase());
    }
} 