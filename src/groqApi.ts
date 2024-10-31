import Groq from "groq-sdk";
import { createLogger } from "./utils/logger";
import { ImageAnalysis } from "./types";

const logger = createLogger("GroqAPI");

export class GroqHandler {
    private groq: Groq;

    constructor(apiKey: string) {
        this.groq = new Groq({
            apiKey,
        });
    }

    /**
     * Generates a text response based on conversation context
     * @param userMessage The user's message
     * @param context Previous conversation context
     * @returns AI-generated response
     */
    public async generateResponse(userMessage: string, context: string): Promise<string> {
        try {
            const completion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are SmolBot, a friendly Discord bot that can analyze images and chat naturally. 
                        Keep responses concise and engaging. Previous conversation context:
                        ${context}`,
                    },
                    {
                        role: "user",
                        content: userMessage,
                    },
                ],
                model: "llama-3.2-90b-text-preview",
                max_tokens: 512,
                temperature: 0.7,
            });

            return completion.choices[0]?.message?.content || "I'm having trouble forming a response.";
        } catch (error) {
            logger.error({ error, userMessage }, "Error generating text response");
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
            const completion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Provide a brief, 1-2 sentence description (max 30 words) of this image. Focus on the main subject and notable visual elements.",
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
                max_tokens: 256,
                temperature: 0.7,
            });

            const analysis = completion.choices[0]?.message?.content || "Unable to analyze image";
            logger.debug({ imageUrl, analysis }, "Light image analysis completed");
            return analysis;
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
            const completion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Provide a detailed analysis (max 150 words) of this image, covering subjects, composition, context, emotions, and notable details. Be descriptive but concise.",
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
                model: "llama-3.2-90b-vision-preview",
                max_tokens: 1024,
                temperature: 0.7,
            });

            const analysis = completion.choices[0]?.message?.content || "Unable to analyze image";
            logger.debug({ imageUrl, analysis }, "Detailed image analysis completed");
            return analysis;
        } catch (error) {
            logger.error({ error, imageUrl }, "Error performing detailed analysis");
            return "Error analyzing image";
        }
    }
} 