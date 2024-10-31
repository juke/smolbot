/**
 * Configuration options for channel cache
 */
interface ChannelCacheOptions {
    maxSize: number;
}

/**
 * Events emitted by the cache manager
 */
enum CacheEvents {
    MESSAGE_ADDED = "messageAdded",
    MESSAGE_REMOVED = "messageRemoved",
    CACHE_CLEARED = "cacheCleared"
}

export { ChannelCacheOptions, CacheEvents }; 