import { TextChannel } from "discord.js";
import { GroqHandler } from "../../groqApi";
import { ContextBuilder } from "./ContextBuilder";
import { ChannelCacheManager } from "../cache/ChannelCacheManager";
import { createLogger } from "../../utils/logger";
import * as fs from "fs/promises";
import * as path from "path";

const logger = createLogger("IntervalMessageHandler");

interface IntervalConfig {
    prompt: string;
    intervalMs: number;
    maxTokens: number;
    temperature: number;
}

/**
 * Handles periodic message interjections based on conversation context
 */
export class IntervalMessageHandler {
    private intervals: Map<string, NodeJS.Timeout> = new Map();
    private config: IntervalConfig | null = null;

    constructor(
        private readonly groqHandler: GroqHandler,
        private readonly contextBuilder: ContextBuilder,
        private readonly cacheManager: ChannelCacheManager
    ) {
        this.loadConfig().catch(error => {
            logger.error({ error }, "Failed to load interval configuration");
        });
    }

    /**
     * Loads interval configuration from system-messages.json
     */
    private async loadConfig(): Promise<void> {
        try {
            const configPath = path.join(__dirname, "../../config/system-messages.json");
            const systemMessages = JSON.parse(await fs.readFile(configPath, "utf-8"));
            
            if (!systemMessages.intervalMessages) {
                throw new Error("intervalMessages configuration not found");
            }

            this.config = systemMessages.intervalMessages as IntervalConfig;
            logger.info("Loaded interval configuration");
        } catch (error) {
            logger.error({ error }, "Error loading interval configuration, using defaults");
            this.config = {
                prompt: "Based on this conversation, generate a borderline-offensive and provoking observation that teases or banters with someone to get their attention. Keep it outrageous and engaging, using @<userid> when appropriate to draw them into the discussion:",
                intervalMs: 60 * 60 * 1000, // 1 hour
                maxTokens: 256,
                temperature: 0.8
            };
        }
    }

    /**
     * Starts monitoring a channel for periodic interjections
     */
    public startMonitoring(channel: TextChannel): void {
        // Clear any existing interval for this channel
        this.stopMonitoring(channel.id);

        logger.info({ channelId: channel.id }, "Starting interval monitoring");

        const interval = setInterval(async () => {
            try {
                await this.generateInterjection(channel);
            } catch (error) {
                logger.error({ error, channelId: channel.id }, "Error generating interjection");
            }
        }, this.config?.intervalMs ?? 3600000);

        this.intervals.set(channel.id, interval);
    }

    /**
     * Stops monitoring a channel
     */
    public stopMonitoring(channelId: string): void {
        const existingInterval = this.intervals.get(channelId);
        if (existingInterval) {
            clearInterval(existingInterval);
            this.intervals.delete(channelId);
            logger.info({ channelId }, "Stopped interval monitoring");
        }
    }

    /**
     * Generates and sends an interjection message
     */
    private async generateInterjection(channel: TextChannel): Promise<void> {
        if (!this.config) {
            logger.error("No configuration loaded for interval messages");
            return;
        }

        const cache = this.cacheManager.getCache(channel.id);
        if (!cache || cache.messages.length === 0) {
            logger.debug({ channelId: channel.id }, "No messages in cache to generate interjection");
            return;
        }

        try {
            // Build context from recent messages
            const context = await this.contextBuilder.buildContext(cache, null);

            // Generate an interjection based on the conversation context
            const response = await this.groqHandler.generateResponse(
                `${this.config.prompt}\n\n${context}`,
                context
            );

            // Send the interjection
            const sentMessage = await channel.send(response);

            // Cache the bot's message
            this.cacheManager.addMessage(channel.id, {
                id: sentMessage.id,
                content: sentMessage.content,
                authorId: sentMessage.author.id,
                authorName: sentMessage.author.username,
                timestamp: sentMessage.createdAt,
                images: [],
            });

            logger.info({ 
                channelId: channel.id, 
                messageId: sentMessage.id 
            }, "Successfully sent interval message");

        } catch (error) {
            logger.error({ 
                error, 
                channelId: channel.id 
            }, "Failed to generate or send interjection");
        }
    }

    /**
     * Forces an immediate interjection
     */
    public async forceInterjection(channel: TextChannel): Promise<void> {
        logger.info({ channelId: channel.id }, "Forcing immediate interjection");
        await this.generateInterjection(channel);
    }
} 