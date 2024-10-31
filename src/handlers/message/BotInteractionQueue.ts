import { TextBasedChannel } from "discord.js";
import { createLogger } from "../../utils/logger";

const logger = createLogger("BotInteractionQueue");

/**
 * Configuration options for the interaction queue
 */
interface QueueOptions {
    /** Minimum delay between actions in milliseconds */
    minDelayMs: number;
}

/**
 * Manages queuing of bot interactions with message spacing
 */
export class BotInteractionQueue {
    private queue: Array<() => Promise<void>> = [];
    private processing = false;
    private readonly options: QueueOptions;

    constructor(options: QueueOptions) {
        this.options = options;
    }

    /**
     * Enqueues a bot interaction with typing indicator
     * @param action - The action to perform
     * @param channel - The channel to show typing in
     * @param priority - Higher priority items are processed first
     */
    public async enqueue(
        action: () => Promise<void>,
        channel: TextBasedChannel,
        priority = 0
    ): Promise<void> {
        const task = async () => {
            try {
                await action();
            } catch (error) {
                logger.error({ error }, "Error executing queued action");
            }
        };

        if (priority > 0) {
            this.queue.unshift(task);
        } else {
            this.queue.push(task);
        }

        if (!this.processing) {
            void this.processQueue();
        }
    }

    /**
     * Processes the queue with delays between actions
     */
    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;

        try {
            while (this.queue.length > 0) {
                const task = this.queue.shift();
                if (task) {
                    await task();
                    // Add delay between actions
                    if (this.queue.length > 0) {
                        await new Promise(resolve => setTimeout(resolve, this.options.minDelayMs));
                    }
                }
            }
        } finally {
            this.processing = false;
        }
    }
} 