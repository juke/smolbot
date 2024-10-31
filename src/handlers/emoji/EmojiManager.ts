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
    // Map emoji IDs to their formatted versions for reverse lookup
    private emojiIdMap: Map<string, string>;

    constructor() {
        this.emojiMap = new Map();
        this.availableEmojis = new Set();
        this.emojiIdMap = new Map();
    }

    /**
     * Updates emoji cache from all available guilds
     */
    public updateEmojiCache(client: Client): void {
        this.emojiMap.clear();
        this.availableEmojis.clear();
        this.emojiIdMap.clear();

        let totalEmojis = 0;
        let animatedCount = 0;

        client.guilds.cache.forEach(guild => {
            guild.emojis.cache.forEach(emoji => {
                if (emoji.name) {
                    const name = emoji.name.toLowerCase();
                    const formatted = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
                    
                    this.emojiMap.set(name, formatted);
                    if (emoji.animated) {
                        this.emojiMap.set(`a${name}`, formatted);
                        animatedCount++;
                    }
                    
                    this.availableEmojis.add(name);
                    this.emojiIdMap.set(emoji.id, formatted);
                    totalEmojis++;
                }
            });
        });

        logger.info({
            totalEmojis,
            animatedCount,
            guilds: client.guilds.cache.size
        }, "Emoji cache updated");
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
     * Formats message text by replacing both :emojiname: and <:emojiname:id> formats
     * This happens after the bot generates its response
     */
    public formatText(text: string): string {
        // First pass: Handle :emojiname: format
        text = text.replace(/:(\w+):/g, (match, emojiName) => {
            const formatted = this.emojiMap.get(emojiName.toLowerCase());
            return formatted || match;
        });

        // Second pass: Handle both static and animated emoji formats
        // Matches both <:name:id> and <a:name:id> patterns
        text = text.replace(/<(a?):([^:]+):(\d+)>/g, (match, animated, emojiName, emojiId) => {
            // Check if we have this exact emoji ID
            const formattedById = this.emojiIdMap.get(emojiId);
            if (formattedById) {
                return formattedById;
            }

            // Fallback to name-based lookup if ID doesn't match
            const formattedByName = this.emojiMap.get(emojiName.toLowerCase());
            if (formattedByName) {
                return formattedByName;
            }

            // If we can't find a match, preserve the original format but ensure it's properly structured
            return `<${animated}:${emojiName}:${emojiId}>`;
        });

        return text;
    }

    /**
     * Checks if an emoji name is available
     */
    public hasEmoji(name: string): boolean {
        return this.availableEmojis.has(name.toLowerCase());
    }

    /**
     * Checks if an emoji ID exists in the cache
     */
    public hasEmojiId(id: string): boolean {
        return this.emojiIdMap.has(id);
    }
} 