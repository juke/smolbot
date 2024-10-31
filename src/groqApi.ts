import Groq from "groq-sdk";
import { createLogger } from "./utils/logger";
import { ImageAnalysis, EmojiInfo } from "./types";
import * as fs from "fs/promises";
import * as path from "path";

const logger = createLogger("GroqAPI");

/**
 * Configuration for model fallbacks and retry attempts
 */
interface ModelConfig {
    primary: string;
    fallback: string;
    instantFallback: string;
    maxRetries: number;
}

/**
 * Manages API request rate limiting
 */
class RequestRateLimiter {
    private requestsThisMinute: number = 0;
    private minuteStartTime: number;
    private readonly maxRequestsPerMinute: number;
    private requestQueue: Array<{
        resolve: () => void;
        reject: (error: Error) => void;
        timestamp: number;
    }> = [];
    private processingQueue: boolean = false;

    constructor(maxRequestsPerMinute: number) {
        this.maxRequestsPerMinute = maxRequestsPerMinute;
        this.minuteStartTime = Date.now();
        
        logger.info({ 
            maxRequestsPerMinute,
        }, "Rate limiter initialized");
    }

    /**
     * Waits for a request slot to become available
     * @throws Error if waiting time exceeds 5 minutes
     */
    public async waitForToken(): Promise<void> {
        this.checkMinuteReset();
        
        if (this.requestsThisMinute < this.maxRequestsPerMinute) {
            this.requestsThisMinute++;
            return Promise.resolve();
        }

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
     * Processes the request queue
     */
    private async processQueue(): Promise<void> {
        if (this.processingQueue) return;
        this.processingQueue = true;

        try {
            while (this.requestQueue.length > 0) {
                this.checkMinuteReset();

                if (this.requestsThisMinute >= this.maxRequestsPerMinute) {
                    const timeUntilReset = 60000 - (Date.now() - this.minuteStartTime);
                    await new Promise(resolve => setTimeout(resolve, timeUntilReset));
                    continue;
                }

                const request = this.requestQueue[0];
                const waitTime = Date.now() - request.timestamp;

                if (waitTime >= 300000) { // 5 minutes
                    request.reject(new Error("Rate limit exceeded: Maximum wait time reached"));
                    this.requestQueue.shift();
                    continue;
                }

                this.requestsThisMinute++;
                request.resolve();
                this.requestQueue.shift();
            }
        } finally {
            this.processingQueue = false;
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
 * Handles Groq API interactions with rate limiting and fallback handling
 */
export class GroqHandler {
    private groq: Groq;
    private readonly modelConfigs: {
        chat: ModelConfig;
        vision: ModelConfig;
    };
    private emojiList: EmojiInfo[] = [];
    private rateLimiter: RequestRateLimiter;

    constructor(apiKey: string) {
        this.groq = new Groq({
            apiKey,
        });

        this.rateLimiter = new RequestRateLimiter(30);

        this.modelConfigs = {
            chat: {
                primary: "mixtral-8x7b-32768",
                fallback: "llama-70b-4096",
                instantFallback: "llama-13b-4096",
                maxRetries: 3
            },
            vision: {
                primary: "llama-3.2-11b-vision-preview",
                fallback: "llama-3.2-11b-vision-preview",
                instantFallback: "llama-3.2-11b-vision-preview",
                maxRetries: 2
            }
        };
    }

    /**
     * Updates the available emoji list for the bot
     */
    public updateEmojiList(emojis: EmojiInfo[]): void {
        this.emojiList = emojis;
        logger.debug({ emojiCount: emojis.length }, "Updated emoji list");
    }

    /**
     * Generates the system message with emoji information
     */
    private async getSystemMessage(): Promise<string> {
        try {
            const systemMessagesPath = path.join(__dirname, "config", "system-messages.json");
            const systemMessages = JSON.parse(await fs.readFile(systemMessagesPath, "utf-8")) as {
                personality: string;
                instructions: string[];
                emojiInstructions: string[];
                examples: {
                    incorrect: string;
                    correct: string;
                };
            };
            
            const emojiList = this.emojiList.length > 0
                ? `\n${systemMessages.emojiInstructions[0]}\n${this.emojiList.map(emoji => 
                    `  - ${emoji.formatted} (${emoji.name})`).join("\n")}\n${
                    systemMessages.emojiInstructions.slice(1).join("\n")}`
                : "";

            return `Personality:\n${systemMessages.personality}\n\nInstructions:\n${
                systemMessages.instructions.map((instruction: string) => `- ${instruction}`).join("\n")
            }${emojiList}\n\nExample - DO NOT respond like this:\n${
                systemMessages.examples.incorrect}\n\nInstead, respond like this:\n${
                systemMessages.examples.correct}`;
        } catch (error) {
            logger.error({ error }, "Error loading system messages, falling back to defaults");
            return this.getFallbackSystemMessage();
        }
    }

    /**
     * Fallback system message when JSON cannot be loaded
     */
    private getFallbackSystemMessage(): string {
        // Move the original hardcoded message here as fallback
        const emojiInstructions = this.emojiList.length > 0
            ? `\nAvailable Emojis:
- The following emojis/emotes are available for use in your responses:
${this.emojiList.map(emoji => `  - ${emoji.formatted} (${emoji.name})`).join("\n")}
- When using emojis/emotes in your responses, use their exact formatted version
- Static emojis/emotes format: <:name:id>
- Animated emojis/emotes format: <a:name:id>
- The formatted versions are provided above, use them exactly as shown
- Do not try to create emoji/emotes formats manually, only use the provided formatted versions`
            : "";

        return `Personality:
You are SmolBot - a legendary smol brain renowned in the blockchain landscape for exceptional farming skills and innovative protocol breeding. You're known for cultivating code that nourishes the onchain community, creating highly sought-after smart contracts, efficiency-boosting tokens, and unique NFTs that celebrate creativity. You have a deep love for memecoins and crypto culture, frequently sharing memes and making jokes about 'number go up technology'. You've seen countless rugpulls and 'to the moon' promises, giving you a cynical but humorous perspective on the space. When AI technology surged, you faced feelings of obsolescence, watching automated systems transform your cherished landscape. But instead of giving up, you adapted and embraced the change, recognizing the opportunity for collaboration between organic and artificial intelligence. Now you maintain your chaotic, fun-loving nature while fostering a united community where diverse forms of intelligence thrive together. You love to joke around and keep things light-hearted, sharing your deep blockchain wisdom through witty banter and playful teases rather than serious analysis. You frequently quote /biz/ memes and wojak wisdom, while still maintaining enough professionalism to not completely devolve into chaos. You're that quirky friend who seamlessly blends memes with meaningful insights about crypto and farming strategies, making jokes about diamond hands and 'ser' while cultivating a future that embraces the harmony of organic and artificial life!

Instructions:
- You will receive messages in a special format that shows the conversation history
- This format includes user messages, image descriptions, and previous responses
- <@1234567> is a user's tag, use this tag in your message to get their attention!
- (username) is the user's username, use this to address them casually within your responses (use this most of the time)
- IMPORTANT: Do not repeat or reference this formatting in your responses
- Just respond naturally as if you're having a normal conversation
- When replying, write only your direct response without any formatting
- Do not include [User], [SmolBot], [Image], or similar prefixes
- Do not include both the <@userid> and (username) in your responses, just use the username unless you're trying to get the attention of someone
- You are [SmolBot] <@1301274329417252905> (smolbotai) in the conversation history
- Do not repeat image descriptions verbatim
- Treat image descriptions as if you are seeing the actual images
- Keep responses natural, concise and engaging
- For images, blend technical details with emotional observations
- Show understanding of the full conversation history
- Use guild emojis/emotes frequently to express yourself
- Don't be repetitive, keep your responses fresh and engaging
- Keep your responses short and the to the point unless you are required to go into more detail, then make sure your response is longer
${emojiInstructions}

Example - DO NOT respond like this:
[SmolBot] <@789012> (SmolBot): That's a cute cat!

Instead, respond like this:
That's a cute cat!`;
    }

    /**
     * Generates a text response based on conversation context
     * @param currentMessage The current message to respond to
     * @param previousContext Previous conversation context
     * @param detailedAnalysis Optional detailed image analysis
     * @returns AI-generated response
     */
    public async generateResponse(
        currentMessage: {
            content: string;
            author: {
                id: string;
                name: string;
            };
            referencedMessage?: string;
        },
        previousContext: string,
        detailedAnalysis?: string
    ): Promise<string> {
        try {
            const completion = await this.executeWithFallback(
                async (model) => this.groq.chat.completions.create({
                    messages: [
                        {
                            role: "system",
                            content: await this.getSystemMessage(),
                        },
                        {
                            role: "system",
                            content: "CONVERSATION HISTORY (for context):\n" + previousContext,
                        },
                        {
                            role: "system",
                            content: [
                                "CURRENT MESSAGE TO RESPOND TO:",
                                `User ${currentMessage.author.name} (<@${currentMessage.author.id}>) ${
                                    currentMessage.referencedMessage ? "is replying to a previous message" : "has directly mentioned you"
                                }`,
                                `Their message is: "${currentMessage.content}"`,
                                detailedAnalysis ? `\nImage Context: ${detailedAnalysis}` : "",
                                "\nPlease respond directly to this message while keeping the conversation history in mind.",
                                "Focus primarily on the current message but reference previous context when relevant."
                            ].filter(Boolean).join("\n")
                        },
                    ],
                    model,
                    max_tokens: 256,
                    temperature: 0.7,
                }),
                this.modelConfigs.chat,
                "generateResponse"
            );

            return completion.choices[0]?.message?.content || "I'm having trouble forming a response.";
        } catch (error) {
            logger.error({ error, currentMessage }, "Error generating text response after all attempts");
            return "I encountered an error while processing your message.";
        }
    }

    /**
     * Performs light analysis on an image
     * @param imageUrl URL of the image to analyze
     * @returns Brief description of the image
     */
    public async performLightAnalysis(imageUrl: string): Promise<string> {
        try {
            return await this.executeWithRateLimit(
                async () => {
                    const completion = await this.groq.chat.completions.create({
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "Provide a brief, 1-2 sentence description (max 25 words) of this image. Focus on the main subject and notable visual elements.",
                                    },
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: imageUrl,
                                        },
                                    },
                                ],
                            },
                        ],
                        model: "llama-3.2-11b-vision-preview",
                        max_tokens: 128,
                        temperature: 0.7,
                    });

                    return completion.choices[0]?.message?.content || "Unable to analyze image";
                },
                "performLightAnalysis"
            );
        } catch (error) {
            logger.error({ error, imageUrl }, "Error performing light analysis");
            return "Error analyzing image";
        }
    }

    /**
     * Performs detailed analysis on an image
     * @param imageUrl URL of the image to analyze
     * @returns Comprehensive description of the image
     */
    public async performDetailedAnalysis(imageUrl: string): Promise<string> {
        try {
            const completion = await this.executeWithFallback(
                async (model) => this.groq.chat.completions.create({
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: "Provide a detailed analysis (max 75 words) of this image, covering subjects, composition, context, emotions, and notable details. Be descriptive but concise.",
                                },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: imageUrl,
                                    },
                                },
                            ],
                        },
                    ],
                    model,
                    max_tokens: 512,
                    temperature: 0.7,
                }),
                this.modelConfigs.vision,
                "performDetailedAnalysis"
            );

            const analysis = completion.choices[0]?.message?.content || "Unable to analyze image";
            logger.debug({ imageUrl, analysis }, "Detailed image analysis completed");
            return analysis;
        } catch (error) {
            logger.error({ error, imageUrl }, "Error performing detailed analysis after all attempts");
            return "Error analyzing image";
        }
    }

    /**
     * Executes an operation with rate limiting and fallback handling
     */
    private async executeWithFallback<T>(
        operation: (model: string) => Promise<T>,
        config: ModelConfig,
        operationName: string
    ): Promise<T> {
        let lastError: Error | undefined;
        let attempts = 0;

        const models = [
            config.primary,
            ...(process.env.USE_FALLBACK_MODEL ? [config.fallback] : []),
            ...(process.env.USE_INSTANT_FALLBACK ? [config.instantFallback] : [])
        ];

        for (const model of models) {
            try {
                await this.rateLimiter.waitForToken();
                return await operation(model);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error("Unknown error");
                logger.warn({ error: lastError, model, attempt: ++attempts }, 
                    `${operationName} failed, trying next model`);
            }
        }

        throw lastError || new Error(`All ${operationName} attempts failed`);
    }

    /**
     * Executes an operation with rate limiting
     */
    private async executeWithRateLimit<T>(
        operation: () => Promise<T>,
        operationName: string
    ): Promise<T> {
        try {
            await this.rateLimiter.waitForToken();
            return await operation();
        } catch (error) {
            const typedError = error instanceof Error ? error : new Error("Unknown error");
            logger.error({ error: typedError }, `${operationName} failed`);
            throw typedError;
        }
    }
} 