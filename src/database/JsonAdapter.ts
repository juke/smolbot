import fs from "fs/promises";
import path from "path";
import { DatabaseInterface } from "./DatabaseInterface";
import { ChannelCache, CachedMessage } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger("JsonAdapter");

/**
 * JSON file implementation of DatabaseInterface
 */
export class JsonAdapter implements DatabaseInterface {
    private readonly dataDir: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
    }

    /**
     * Initializes data directory
     */
    public async initialize(): Promise<void> {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
            logger.info("Data directory initialized successfully");
        } catch (error) {
            logger.error({ error }, "Failed to initialize data directory");
            throw error;
        }
    }

    /**
     * Saves a channel's cache to a JSON file
     */
    public async saveChannelCache(channelId: string, cache: ChannelCache): Promise<void> {
        try {
            const filePath = path.join(this.dataDir, `${channelId}.json`);
            await fs.writeFile(filePath, JSON.stringify(cache, null, 2));
            logger.debug({ channelId }, "Channel cache saved to file");
        } catch (error) {
            logger.error({ error, channelId }, "Failed to save channel cache");
            throw error;
        }
    }

    /**
     * Retrieves a channel's cache from its JSON file
     */
    public async getChannelCache(channelId: string): Promise<ChannelCache | undefined> {
        try {
            const filePath = path.join(this.dataDir, `${channelId}.json`);
            const data = await fs.readFile(filePath, "utf-8");
            const cache = JSON.parse(data) as ChannelCache;

            // Convert timestamp strings back to Date objects
            cache.messages = cache.messages.map(msg => ({
                ...msg,
                timestamp: new Date(msg.timestamp)
            }));

            return cache;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                // File doesn't exist yet, return undefined
                return undefined;
            }
            logger.error({ error, channelId }, "Failed to load channel cache");
            return undefined;
        }
    }

    /**
     * Deletes a channel's cache file
     */
    public async deleteChannelCache(channelId: string): Promise<void> {
        try {
            const filePath = path.join(this.dataDir, `${channelId}.json`);
            await fs.unlink(filePath);
            logger.debug({ channelId }, "Channel cache deleted");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                logger.error({ error, channelId }, "Failed to delete channel cache");
                throw error;
            }
        }
    }
} 