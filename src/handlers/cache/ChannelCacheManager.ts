import { EventEmitter } from "events";
import { ChannelCache, CachedMessage } from "../../types";
import { ChannelCacheOptions, CacheEvents } from "./types";
import { createLogger } from "../../utils/logger";
import { DatabaseInterface } from "../../database/DatabaseInterface";

const logger = createLogger("ChannelCacheManager");

/**
 * Manages channel message caches with event emission
 */
export class ChannelCacheManager extends EventEmitter {
    private caches: Map<string, ChannelCache>;
    private readonly options: ChannelCacheOptions;
    private syncInterval: NodeJS.Timeout | null = null;

    constructor(
        options: ChannelCacheOptions,
        private readonly database: DatabaseInterface
    ) {
        super();
        this.caches = new Map();
        this.options = options;
        
        // Start periodic database sync
        this.startPeriodicSync();
    }

    /**
     * Starts periodic database synchronization
     */
    private startPeriodicSync(): void {
        // Sync to database every 5 minutes
        this.syncInterval = setInterval(() => {
            this.syncAllCachesToDatabase();
        }, 5 * 60 * 1000);
    }

    /**
     * Syncs all caches to database
     */
    private async syncAllCachesToDatabase(): Promise<void> {
        for (const [channelId, cache] of this.caches.entries()) {
            try {
                await this.database.saveChannelCache(channelId, cache);
                logger.debug({ channelId }, "Synced channel cache to database");
            } catch (error) {
                logger.error({ error, channelId }, "Failed to sync channel cache to database");
            }
        }
    }

    /**
     * Loads channel cache from database
     */
    public async loadCache(channelId: string): Promise<void> {
        try {
            const cache = await this.database.getChannelCache(channelId);
            if (cache) {
                this.caches.set(channelId, cache);
                logger.info({ channelId, messageCount: cache.messages.length }, 
                    "Loaded channel cache from database");
            }
        } catch (error) {
            logger.error({ error, channelId }, "Failed to load channel cache");
        }
    }

    /**
     * Adds a message to the channel cache and immediately persists to database
     */
    public async addMessage(channelId: string, message: CachedMessage): Promise<void> {
        let cache = this.caches.get(channelId);
        
        if (!cache) {
            cache = { messages: [] };
            this.caches.set(channelId, cache);
        }

        cache.messages.push(message);
        this.emit(CacheEvents.MESSAGE_ADDED, channelId, message);

        // Maintain cache size
        if (cache.messages.length > this.options.maxSize) {
            const removed = cache.messages.shift();
            if (removed) {
                this.emit(CacheEvents.MESSAGE_REMOVED, channelId, removed);
            }
        }

        // Immediately persist to database
        try {
            await this.database.saveChannelCache(channelId, cache);
        } catch (error) {
            logger.error({ error, channelId }, "Failed to persist channel cache");
        }
    }

    /**
     * Cleans up resources when shutting down
     */
    public async cleanup(): Promise<void> {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        // Final sync to database
        await this.syncAllCachesToDatabase();
    }

    /**
     * Gets the cache for a specific channel
     */
    public getCache(channelId: string): ChannelCache | undefined {
        return this.caches.get(channelId);
    }

    /**
     * Clears the cache for a specific channel
     */
    public clearCache(channelId: string): void {
        this.caches.delete(channelId);
        this.emit(CacheEvents.CACHE_CLEARED, channelId);
    }

    /**
     * Gets the maximum cache size
     */
    public getMaxSize(): number {
        return this.options.maxSize;
    }
} 