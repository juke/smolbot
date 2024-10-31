import { Client, GuildEmoji } from "discord.js";
import { createLogger } from "../../utils/logger";

const logger = createLogger("EmojiManager");

/**
 * Simplified emoji manager for handling Discord guild emojis
 */
export class EmojiManager {
    private emojiMap: Map<string, string>;

    constructor() {
        this.emojiMap = new Map();
    }

    /**
     * Updates emoji cache from all available guilds
     */
    public updateEmojiCache(client: Client): void {
        this.emojiMap.clear();
        const emojis: string[] = [];

        client.guilds.cache.forEach(guild => {
            guild.emojis.cache.forEach(emoji => {
                if (emoji.name) {
                    const formatted = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
                    this.emojiMap.set(emoji.name.toLowerCase(), formatted);
                    emojis.push(`${emoji.name} - Use :${emoji.name}: to get ${formatted}`);
                }
            });
        });

        logger.debug({ 
            emojiCount: emojis.length,
            availableEmojis: emojis
        }, "Updated emoji cache");
    }

    /**
     * Gets all available emojis with usage instructions
     */
    public getAvailableEmojis(): string[] {
        return Array.from(this.emojiMap.entries())
            .map(([name, formatted]) => `${name} - Use :${name}: to get ${formatted}`);
    }

    /**
     * Formats text by replacing :emojiname: with proper Discord emoji format
     */
    public formatText(text: string): string {
        return text.replace(/:(\w+):/g, (match, emojiName) => {
            const formatted = this.emojiMap.get(emojiName.toLowerCase());
            return formatted || match;
        });
    }

    /**
     * Gets a single formatted emoji by name
     */
    public getEmoji(name: string): string | undefined {
        return this.emojiMap.get(name.toLowerCase());
    }
} 