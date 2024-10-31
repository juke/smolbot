import Groq from "groq-sdk";
import { createLogger } from "./utils/logger";
import { ImageAnalysis, EmojiInfo } from "./types";
import * as fs from "fs/promises";
import * as path from "path";
import { EmojiManager } from "./handlers/emoji/EmojiManager";
import { Client } from "discord.js";

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
 * Handles Groq API interactions with fallback handling
 */
export class GroqHandler {
    private groq: Groq;
    private readonly modelConfigs: {
        chat: ModelConfig;
        vision: ModelConfig;
    };
    private emojiManager: EmojiManager;
    private systemMessage: string = "";

    constructor(apiKey: string) {
        this.groq = new Groq({ apiKey });
        this.emojiManager = new EmojiManager();
        this.modelConfigs = {
            chat: {
                primary: "llama-3.2-90b-text-preview",
                fallback: "llama-3.1-70b-versatile",
                instantFallback: "llama-3.1-8b-instant",
                maxRetries: 3
            },
            vision: {
                primary: "llama-3.2-11b-vision-preview",
                fallback: "llama-3.2-11b-vision-preview",
                instantFallback: "llama-3.2-11b-vision-preview",
                maxRetries: 2
            }
        };
        // Load system message immediately
        void this.loadSystemMessage();
    }

    /**
     * Updates emoji list and refreshes system message
     */
    public updateEmojiList(client: Client): void {
        this.emojiManager.updateEmojiCache(client);
        void this.loadSystemMessage();
    }

    /**
     * Loads and formats system message with current emoji list
     */
    private async loadSystemMessage(): Promise<string> {
        try {
            const systemMessages = await fs.readFile(
                path.join(__dirname, "config", "system-messages.json"), 
                "utf-8"
            );
            
            const messages = JSON.parse(systemMessages);
            const emojiList = this.emojiManager.getAvailableEmojis()
                .map(emoji => `:${emoji}:`)
                .join("\n");
            
            const emojiInstructions = `
STRICT EMOJI USAGE RULES:
- ONLY use emojis from this exact list (case-insensitive):
${emojiList}
- Always use exactly ONE colon on each side of the emoji name
- Correct format: :emojiname:
- Incorrect formats: ::emojiname:: or emojiname
- Do not create or guess emoji names
- If unsure about an emoji, do not use it
- Each emoji must be used exactly as shown above (though case doesn't matter)
- No custom or made-up emoji names allowed
- Use emojis often to keep your responses fun and engaging`;

            this.systemMessage = `${messages.personality}\n\n${messages.instructions.join("\n")}\n${emojiInstructions}`;

            logger.debug({ 
                emojiCount: this.emojiManager.getAvailableEmojis().length,
                systemMessageLength: this.systemMessage.length,
                availableEmojis: this.emojiManager.getAvailableEmojis()
            }, "System message updated with strict emoji rules");

            return this.systemMessage;
        } catch (error) {
            logger.error({ error }, "Error loading system messages");
            return this.getFallbackSystemMessage();
        }
    }

    /**
     * Fallback system message when JSON cannot be loaded
     */
    private getFallbackSystemMessage(): string {
        const availableEmojis = this.emojiManager.getAvailableEmojis();
        const emojiInstructions = availableEmojis.length > 0
            ? `\nAvailable Emojis:
- The following emojis/emotes are available for use in your responses:
${availableEmojis.map(emoji => `  - ${emoji}`).join("\n")}
- Use emojis in the format :emojiname: - they will be automatically formatted
- Only use emojis from the available list above
- The bot will automatically convert :emojiname: to the proper Discord format
- Do not try to format emojis manually with < > symbols
- If an emoji name is not in the list, it won't be converted`
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
     * Generates a response with proper emoji formatting and validation
     */
    public async generateResponse(currentMessage: any, context: string): Promise<string> {
        const startTime = Date.now();
        try {
            // Ensure system message is loaded
            if (!this.systemMessage) {
                await this.loadSystemMessage();
            }

            logger.debug({ 
                context, 
                currentMessage,
                systemMessageLength: this.systemMessage.length 
            }, "Generating response with context");

            const completion = await this.executeWithFallback(
                async (model) => this.groq.chat.completions.create({
                    messages: [
                        { 
                            role: "system", 
                            content: this.systemMessage 
                        },
                        { 
                            role: "user", 
                            content: `${context}\n\nRespond to the current message marked with >>>`
                        }
                    ],
                    model,
                    temperature: 0.8,
                    max_tokens: 1024,
                    stop: ["[User]", "[SmolBot]", "[Image]"]
                }),
                this.modelConfigs.chat,
                "generateResponse"
            );

            let response = completion.choices[0]?.message?.content || "";
            
            // Validate and clean emojis before formatting
            response = this.validateAndCleanEmojis(response);
            
            const duration = Date.now() - startTime;
            logger.info({ duration }, "Groq API response received and cleaned");
            
            return this.emojiManager.formatText(response);

        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error({ error, duration }, "Error generating response");
            return "sorry, i'm having trouble thinking right now :sadge:";
        }
    }

    /**
     * Validates and cleans emoji usage in the response
     */
    private validateAndCleanEmojis(text: string): string {
        // First fix any double colons
        text = text.replace(/:(:[\w-]+:)/g, "$1");
        
        // Then validate emojis
        return text.replace(/:(\w+):/g, (match, emojiName) => {
            if (this.emojiManager.hasEmoji(emojiName)) {
                return match; // Keep valid emojis
            }
            logger.warn({ 
                invalidEmoji: emojiName,
                availableEmojis: Array.from(this.emojiManager.getAvailableEmojis())
            }, "Removing invalid emoji from response");
            return ""; // Remove invalid emojis
        });
    }

    /**
     * Performs light analysis on an image
     * @param imageUrl URL of the image to analyze
     * @returns Brief description of the image
     */
    public async performLightAnalysis(imageUrl: string): Promise<string> {
        try {
            const completion = await this.executeWithFallback(
                async (model) => this.groq.chat.completions.create({
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
                }),
                this.modelConfigs.vision,
                "performLightAnalysis"
            );

            return completion.choices[0]?.message?.content || "Unable to analyze image";
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
     * Executes API call with fallback handling and rate limit backoff
     */
    private async executeWithFallback<T>(
        operation: (model: string) => Promise<T>,
        config: ModelConfig,
        operationName: string
    ): Promise<T> {
        const models = [config.primary, config.fallback, config.instantFallback];
        let lastError: Error | null = null;

        for (const model of models) {
            try {
                return await operation(model);
            } catch (error) {
                lastError = error as Error;
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                
                if (errorMessage.includes("Rate limit reached")) {
                    logger.warn({ 
                        component: "GroqAPI",
                        model,
                        error 
                    }, `${operationName}: Model rate limited, switching to next available model`);
                    
                    // Add delay before trying next model to avoid rapid rate limit hits
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                throw error;
            }
        }

        throw lastError || new Error("All models failed");
    }
} 