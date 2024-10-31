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

        for (const guild of client.guilds.cache.values()) {
            for (const emoji of guild.emojis.cache.values()) {
                // Store both original and lowercase versions of emoji names
                const emojiName = emoji.name;
                if (emojiName) {
                    const formattedEmoji = `<${emoji.animated ? "a" : ""}:${emojiName}:${emoji.id}>`;
                    // Store with original case
                    this.emojiMap.set(emojiName, formattedEmoji);
                    // Store with lowercase
                    this.emojiMap.set(emojiName.toLowerCase(), formattedEmoji);
                    // Store original case in available emojis for system message
                    this.availableEmojis.add(emojiName);
                    this.emojiIdMap.set(emoji.id, formattedEmoji);
                }
            }
        }
    }

    /**
     * Gets list of available emoji names for bot context
     * Returns simple :emojiname: format
     */
    public getAvailableEmojis(): string[] {
        return Array.from(this.availableEmojis)
            .sort() // Sort alphabetically for consistency
            .map(name => name); // Return just the names without colons
    }

    /**
     * Formats message text by replacing both :emojiname: and <:emojiname:id> formats
     * This happens after the bot generates its response
     */
    public formatText(text: string): string {
        // First, fix any double colons that might exist
        text = text.replace(/:(:[\w-]+:)/g, "$1");

        return text.split(/(\s+)/).map(segment => {
            // If this segment is already a properly formatted emoji tag, leave it unchanged
            if (segment.match(/^<(?:a?):[\w-]+:\d+>$/)) {
                return segment;
            }

            // Process :emojiname: formats case-insensitively
            return segment.replace(/:(\w+):/g, (match, emojiName) => {
                // Try exact match first, then lowercase
                const formatted = this.emojiMap.get(emojiName) || 
                                this.emojiMap.get(emojiName.toLowerCase());
                
                // Log any emoji formatting for debugging
                if (formatted) {
                    logger.debug({ 
                        original: match, 
                        formatted,
                        emojiName 
                    }, "Formatting emoji");
                }
                
                return formatted || match;
            });
        }).join("");
    }

    /**
     * Checks if an emoji name is available (case-insensitive)
     */
    public hasEmoji(name: string): boolean {
        // Check both original case and lowercase
        return this.availableEmojis.has(name) || 
               Array.from(this.availableEmojis).some(emoji => 
                   emoji.toLowerCase() === name.toLowerCase()
               );
    }

    /**
     * Checks if an emoji ID exists in the cache
     */
    public hasEmojiId(id: string): boolean {
        return this.emojiIdMap.has(id);
    }
} 