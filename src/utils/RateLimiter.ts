import { createLogger } from "./logger";

const logger = createLogger("RateLimiter");

interface RateLimiterOptions {
    tokensPerInterval: number;
    intervalMs: number;
    maxTokens: number;
}

interface QueuedRequest {
    resolve: () => void;
    reject: (error: Error) => void;
    timestamp: number;
}

/**
 * Implements token bucket algorithm for rate limiting with request queuing
 */
export class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private readonly options: RateLimiterOptions;
    private requestQueue: QueuedRequest[] = [];
    private processingQueue: boolean = false;

    constructor(options: RateLimiterOptions) {
        this.options = options;
        this.tokens = options.maxTokens;
        this.lastRefill = Date.now();
    }

    /**
     * Refills tokens based on time elapsed
     */
    private refillTokens(): void {
        const now = Date.now();
        const timePassed = now - this.lastRefill;
        const tokensToAdd = Math.floor(
            (timePassed * this.options.tokensPerInterval) / this.options.intervalMs
        );

        if (tokensToAdd > 0) {
            this.tokens = Math.min(
                this.options.maxTokens,
                this.tokens + tokensToAdd
            );
            this.lastRefill = now;
        }
    }

    /**
     * Processes the request queue
     */
    private async processQueue(): Promise<void> {
        if (this.processingQueue) return;
        this.processingQueue = true;

        try {
            while (this.requestQueue.length > 0) {
                this.refillTokens();

                if (this.tokens <= 0) {
                    const timeUntilNextToken = Math.ceil(
                        (this.options.intervalMs / this.options.tokensPerInterval)
                    );
                    await new Promise(resolve => setTimeout(resolve, timeUntilNextToken));
                    continue;
                }

                const request = this.requestQueue[0];
                const now = Date.now();
                const waitTime = now - request.timestamp;

                if (waitTime >= 300000) { // 5 minutes
                    request.reject(new Error("Rate limit exceeded: Maximum wait time reached"));
                    this.requestQueue.shift();
                    continue;
                }

                this.tokens--;
                request.resolve();
                this.requestQueue.shift();

                logger.debug({ 
                    remainingTokens: this.tokens,
                    queueLength: this.requestQueue.length,
                    waitTime 
                }, "Token consumed");
            }
        } finally {
            this.processingQueue = false;
        }
    }

    /**
     * Waits for a token to become available
     * @throws Error if waiting time exceeds 5 minutes
     */
    public async waitForToken(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                resolve,
                reject,
                timestamp: Date.now()
            });

            // Start processing queue if not already running
            this.processQueue().catch(error => {
                logger.error({ error }, "Error processing rate limit queue");
            });
        });
    }

    /**
     * Gets the current number of available tokens and queue length
     */
    public getStatus(): { availableTokens: number; queueLength: number } {
        this.refillTokens();
        return {
            availableTokens: this.tokens,
            queueLength: this.requestQueue.length
        };
    }
} 