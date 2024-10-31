import { createLogger } from "../../utils/logger";

const logger = createLogger("BotInteractionQueue");

interface QueueOptions {
    maxConcurrent: number;
    minDelayMs: number;
}

/**
 * Manages API request rate limiting
 */
class RequestRateLimiter {
    private requestsThisMinute: number = 0;
    private minuteStartTime: number;
    private readonly maxRequestsPerMinute: number;

    constructor(maxRequestsPerMinute: number) {
        this.maxRequestsPerMinute = maxRequestsPerMinute;
        this.minuteStartTime = Date.now();
        
        logger.info({ 
            maxRequestsPerMinute,
        }, "Rate limiter initialized");
    }

    /**
     * Checks current request count status
     */
    public async getStatus(): Promise<{ available: boolean }> {
        this.checkMinuteReset();
        return { 
            available: this.requestsThisMinute < this.maxRequestsPerMinute 
        };
    }

    /**
     * Executes a request and only counts it if successful
     */
    public async executeRequest<T>(
        operation: () => Promise<T>
    ): Promise<{ success: boolean; result?: T; error?: Error }> {
        this.checkMinuteReset();
        
        if (this.requestsThisMinute >= this.maxRequestsPerMinute) {
            return { success: false };
        }

        try {
            const result = await operation();
            // Only increment counter if request succeeds
            this.requestsThisMinute++;
            logger.debug({ 
                requestsThisMinute: this.requestsThisMinute,
                maxRequestsPerMinute: this.maxRequestsPerMinute,
                timeUntilReset: Math.ceil((this.minuteStartTime + 60000 - Date.now()) / 1000)
            }, "Request processed successfully");
            return { success: true, result };
        } catch (error) {
            if (error instanceof Error) {
                return { success: false, error };
            }
            return { success: false, error: new Error("Unknown error occurred") };
        }
    }

    /**
     * Resets request count if minute has elapsed
     */
    private checkMinuteReset(): void {
        const now = Date.now();
        const timeElapsed = now - this.minuteStartTime;
        
        if (timeElapsed >= 60000) { // 60 seconds in milliseconds
            const minutesElapsed = Math.floor(timeElapsed / 60000);
            this.requestsThisMinute = 0;
            this.minuteStartTime = now - (timeElapsed % 60000);
            
            logger.debug({ 
                minutesElapsed,
                requestsReset: true,
                newMinuteStartTime: new Date(this.minuteStartTime).toISOString()
            }, "Request counter reset");
        }
    }
}

/**
 * Manages queuing of bot interactions with intelligent model fallback
 */
export class BotInteractionQueue {
    private queue: Array<{
        interaction: () => Promise<void>;
        timestamp: number;
        priority: number;
    }> = [];
    private processing: number = 0;
    private readonly options: QueueOptions;
    private readonly rateLimiter: RequestRateLimiter;

    constructor(options: QueueOptions = { maxConcurrent: 3, minDelayMs: 250 }) {
        this.options = options;
        // Initialize rate limiter with 30 requests per minute
        this.rateLimiter = new RequestRateLimiter(30);
    }

    /**
     * Adds an interaction to the queue with priority handling
     */
    public async enqueue(
        interaction: () => Promise<void>,
        priority: number = 1
    ): Promise<void> {
        this.queue.push({
            interaction,
            timestamp: Date.now(),
            priority
        });

        logger.debug({ 
            queueLength: this.queue.length,
            currentlyProcessing: this.processing,
            priority 
        }, "Added interaction to queue");
        
        await this.processQueue();
    }

    /**
     * Processes queued interactions with priority and fallback handling
     */
    private async processQueue(): Promise<void> {
        if (this.processing >= this.options.maxConcurrent) {
            return;
        }

        // Sort queue by priority and timestamp
        this.queue.sort((a, b) => {
            if (a.priority !== b.priority) {
                return b.priority - a.priority; // Higher priority first
            }
            return a.timestamp - b.timestamp; // Older timestamps first
        });

        while (this.queue.length > 0 && this.processing < this.options.maxConcurrent) {
            const item = this.queue.shift();
            if (!item) continue;

            this.processing++;
            
            try {
                // Check if we can use the main model
                const { available } = await this.rateLimiter.getStatus();

                if (available) {
                    await this.processWithMainModel(item.interaction);
                } else {
                    // Use fallback model if rate limited
                    logger.debug("Rate limit reached, using fallback model");
                    await this.processFallback(item.interaction);
                }
            } catch (error) {
                logger.error({ error }, "Error in queue processing");
            } finally {
                this.processing--;
                // Continue processing queue
                this.processQueue().catch(error => {
                    logger.error({ error }, "Error in queue processing");
                });
            }

            // Add delay between starting new interactions
            if (this.queue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.options.minDelayMs));
            }
        }
    }

    /**
     * Processes interaction with main model
     */
    private async processWithMainModel(
        interaction: () => Promise<void>
    ): Promise<void> {
        const { success, error } = await this.rateLimiter.executeRequest(interaction);
        
        if (!success) {
            if (error?.message.includes("rate limit")) {
                logger.debug("Rate limit reached, using fallback model");
                await this.processFallback(interaction);
            } else if (error) {
                logger.error({ error }, "Error executing request with main model");
                throw error;
            } else {
                logger.debug("Rate limit reached, using fallback model");
                await this.processFallback(interaction);
            }
        }
    }

    /**
     * Processes interaction using fallback model
     */
    private async processFallback(interaction: () => Promise<void>): Promise<void> {
        try {
            // Try regular fallback first
            process.env.USE_FALLBACK_MODEL = "true";
            await interaction();
        } catch (error) {
            // If regular fallback fails, try instant fallback
            logger.debug("Regular fallback failed, using instant fallback model");
            process.env.USE_INSTANT_FALLBACK = "true";
            await interaction();
        } finally {
            // Reset environment variables
            delete process.env.USE_FALLBACK_MODEL;
            delete process.env.USE_INSTANT_FALLBACK;
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