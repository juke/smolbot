import { createLogger } from "../../utils/logger";
import { TextBasedChannel } from "discord.js";

const logger = createLogger("BotInteractionQueue");

interface QueueOptions {
    minDelayMs: number;
}

/**
 * Type for channels that support typing indicators
 */
type TypingCapableChannel = TextBasedChannel & {
    sendTyping: () => Promise<void>;
};

/**
 * Manages queuing of bot interactions with message spacing
 */
export class BotInteractionQueue {
    private queue: Array<{
        interaction: () => Promise<void>;
        timestamp: number;
        priority: number;
        channel: TextBasedChannel;
    }> = [];
    private processing: boolean = false;
    private readonly options: QueueOptions;

    constructor(options: QueueOptions = { minDelayMs: 2000 }) {
        this.options = options;
    }

    /**
     * Adds an interaction to the queue with priority handling
     */
    public async enqueue(
        interaction: () => Promise<void>,
        channel: TextBasedChannel,
        priority: number = 1
    ): Promise<void> {
        this.queue.push({
            interaction,
            channel,
            timestamp: Date.now(),
            priority
        });

        logger.debug({ 
            queueLength: this.queue.length,
            isProcessing: this.processing,
            priority 
        }, "Added interaction to queue");
        
        if (!this.processing) {
            await this.processQueue();
        }
    }

    /**
     * Processes queued interactions one at a time
     */
    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        try {
            // Sort queue by priority and timestamp
            this.queue.sort((a, b) => {
                if (a.priority !== b.priority) {
                    return b.priority - a.priority; // Higher priority first
                }
                return a.timestamp - b.timestamp; // Older timestamps first
            });

            while (this.queue.length > 0) {
                const item = this.queue.shift();
                if (!item) continue;

                // Start typing indicator
                const typingInterval = this.startTypingInterval(item.channel);

                try {
                    // Wait for initial delay with typing indicator
                    await new Promise(resolve => setTimeout(resolve, this.options.minDelayMs));
                    
                    // Process the interaction
                    await item.interaction();
                } catch (error) {
                    logger.error({ error }, "Error in queue processing");
                } finally {
                    // Clear typing indicator
                    clearInterval(typingInterval);
                    
                    // Add delay before next message if there is one
                    if (this.queue.length > 0) {
                        await new Promise(resolve => setTimeout(resolve, this.options.minDelayMs));
                    }
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Starts a typing indicator interval
     */
    private startTypingInterval(channel: TextBasedChannel): NodeJS.Timeout {
        // Send initial typing indicator
        if (this.canShowTyping(channel)) {
            void channel.sendTyping().catch((error: Error) => {
                logger.warn({ error, channelId: channel.id }, "Failed to send typing indicator");
            });
        }

        // Continue showing typing every 8 seconds (Discord's typing timeout is 10 seconds)
        return setInterval(() => {
            if (this.canShowTyping(channel)) {
                void channel.sendTyping().catch((error: Error) => {
                    logger.warn({ error, channelId: channel.id }, "Failed to send typing indicator");
                });
            }
        }, 8000);
    }

    /**
     * Type guard for channels that support typing indicators
     */
    private canShowTyping(channel: TextBasedChannel): channel is TypingCapableChannel {
        return 'sendTyping' in channel;
    }

    /**
     * Gets the current queue status
     */
    public getStatus(): { queueLength: number; processing: boolean } {
        return {
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
} 