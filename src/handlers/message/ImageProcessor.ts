import { Message } from "discord.js";
import { ImageAnalysis } from "../../types";
import { GroqHandler } from "../../groqApi";
import { createLogger } from "../../utils/logger";

const logger = createLogger("ImageProcessor");

/**
 * Handles image processing and analysis
 */
export class ImageProcessor {
    constructor(private groqHandler: GroqHandler) {}

    /**
     * Processes all images in a message
     */
    public async processImages(message: Message): Promise<ImageAnalysis[]> {
        const images: ImageAnalysis[] = [];
        
        for (const attachment of message.attachments.values()) {
            if (attachment.contentType?.startsWith("image/")) {
                try {
                    const lightAnalysis = await this.groqHandler.performLightAnalysis(attachment.url);
                    images.push({ url: attachment.url, lightAnalysis });
                } catch (error) {
                    logger.error({ error, messageId: message.id }, "Error processing image");
                }
            }
        }

        return images;
    }

    /**
     * Performs detailed analysis on a specific image
     */
    public async performDetailedAnalysis(imageUrl: string): Promise<string> {
        try {
            return await this.groqHandler.performDetailedAnalysis(imageUrl);
        } catch (error) {
            logger.error({ error, imageUrl }, "Error performing detailed analysis");
            return "Error analyzing image";
        }
    }
} 