import { ChannelCache } from "../types";

/**
 * Interface for database operations related to message caching
 */
export interface DatabaseInterface {
    /**
     * Saves a channel's message cache to persistent storage
     */
    saveChannelCache(channelId: string, cache: ChannelCache): Promise<void>;
    
    /**
     * Retrieves a channel's message cache from persistent storage
     */
    getChannelCache(channelId: string): Promise<ChannelCache | undefined>;
    
    /**
     * Deletes a channel's message cache from persistent storage
     */
    deleteChannelCache(channelId: string): Promise<void>;
} 