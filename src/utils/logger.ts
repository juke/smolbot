import pino from "pino";

/**
 * Centralized logger configuration for consistent logging across the application
 */
const baseLogger = pino({
    level: "debug", // Set logging level to debug
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            messageFormat: "{component}: {msg}",
        },
    },
});

/**
 * Creates a child logger with component-specific context
 * @param component Name of the component for contextual logging
 */
export function createLogger(component: string): pino.Logger {
    return baseLogger.child({ component });
}