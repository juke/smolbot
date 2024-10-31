import pino from "pino";

/**
 * Type definition for conversation context in logs
 */
interface ConversationContext {
    previousMessages?: string;
    currentMessage?: string;
    detailedAnalysis?: string;
}

/**
 * Centralized logger configuration for consistent logging across the application
 */
const baseLogger = pino({
    level: "debug",
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            messageFormat: "{component}: {msg}",
        },
    },
    formatters: {
        log(object: Record<string, unknown>) {
            // Format conversation context if present
            if (object.context && typeof object.context === "object") {
                const context = object.context as ConversationContext;
                const formattedContext = [
                    "\n=== Bot's Conversation View ===\n",
                    context.previousMessages ? `\nPrevious Messages:\n${context.previousMessages}\n` : "",
                    context.currentMessage ? `\nCurrent Message:\n${context.currentMessage}\n` : "",
                    context.detailedAnalysis ? `\nImage Analysis:\n${context.detailedAnalysis}\n` : "",
                    "\n=============================\n"
                ].join("");

                return {
                    ...object,
                    context: formattedContext
                };
            }
            return object;
        }
    }
});

/**
 * Creates a child logger with component-specific context
 * @param component Name of the component for contextual logging
 */
export function createLogger(component: string): pino.Logger {
    return baseLogger.child({ component });
}