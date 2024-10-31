import { createLogger } from "../../utils/logger";

const logger = createLogger("BotInteractionQueue");

interface QueueOptions {
    maxConcurrent: number;
    minDelayMs: number;
}

/**
 * Manages queuing of bot interactions with concurrent processing
 */
export class BotInteractionQueue {
    private queue: Array<() => Promise<void>> = [];
    private processing: number = 0;
    private readonly options: QueueOptions;

    constructor(options: QueueOptions = { maxConcurrent: 3, minDelayMs: 250 }) {
        this.options = options;
    }

    /**
     * Adds an interaction to the queue and processes it when ready
     */
    public async enqueue(interaction: () => Promise<void>): Promise<void> {
        this.queue.push(interaction);
        logger.debug({ 
            queueLength: this.queue.length,
            currentlyProcessing: this.processing 
        }, "Added interaction to queue");
        
        await this.processQueue();
    }

    /**
     * Processes queued interactions with controlled concurrency
     */
    private async processQueue(): Promise<void> {
        // If we're at max concurrent processing, wait
        if (this.processing >= this.options.maxConcurrent) {
            return;
        }

        // Process as many items as we can up to maxConcurrent
        while (this.queue.length > 0 && this.processing < this.options.maxConcurrent) {
            const interaction = this.queue.shift();
            if (!interaction) continue;

            this.processing++;
            
            // Process the interaction
            this.processInteraction(interaction).finally(() => {
                this.processing--;
                // Try to process more from the queue
                this.processQueue().catch(error => {
                    logger.error({ error }, "Error in queue processing");
                });
            });

            // Add a small delay between starting new interactions
            if (this.queue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.options.minDelayMs));
            }
        }
    }

    /**
     * Processes a single interaction with error handling
     */
    private async processInteraction(interaction: () => Promise<void>): Promise<void> {
        try {
            await interaction();
        } catch (error) {
            logger.error({ error }, "Error processing queued interaction");
        }
    }

    /**
     * Gets the current queue status
     */
    public getStatus(): { queueLength: number; processing: number } {
        return {
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
} 