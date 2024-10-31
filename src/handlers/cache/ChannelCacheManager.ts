import { EventEmitter } from "events";
import { ChannelCache, CachedMessage } from "../../types";
import { ChannelCacheOptions, CacheEvents } from "./types";
import { createLogger } from "../../utils/logger";

const logger = createLogger("ChannelCacheManager");

/**
 * Manages channel message caches with event emission
 */
export class ChannelCacheManager extends EventEmitter {
    private caches: Map<string, ChannelCache>;
    private readonly options: ChannelCacheOptions;

    constructor(options: ChannelCacheOptions) {
        super();
        this.caches = new Map();
        this.options = options;
    }

    /**
     * Adds a message to the channel cache
     */
    public addMessage(channelId: string, message: CachedMessage): void {
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