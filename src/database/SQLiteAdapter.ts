import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { DatabaseInterface } from "./DatabaseInterface";
import { ChannelCache, CachedMessage, ImageAnalysis } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger("SQLiteAdapter");

/**
 * SQLite implementation of DatabaseInterface
 */
export class SQLiteAdapter implements DatabaseInterface {
    private db: Database | null = null;
    
    constructor(private readonly dbPath: string) {}
    
    /**
     * Initializes database connection and creates required tables
     */
    public async initialize(): Promise<void> {
        try {
            this.db = await open({
                filename: this.dbPath,
                driver: sqlite3.Database
            });
            
            await this.createTables();
            logger.info("Database initialized successfully");
        } catch (error) {
            logger.error({ error }, "Failed to initialize database");
            throw error;
        }
    }
    
    /**
     * Creates necessary database tables if they don't exist
     */
    private async createTables(): Promise<void> {
        if (!this.db) throw new Error("Database not initialized");
        
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                content TEXT NOT NULL,
                author_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                referenced_message_id TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE IF NOT EXISTS image_analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                url TEXT NOT NULL,
                light_analysis TEXT NOT NULL,
                detailed_analysis TEXT,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_channel 
            ON messages(channel_id, timestamp);
        `);
    }

    public async saveChannelCache(channelId: string, cache: ChannelCache): Promise<void> {
        if (!this.db) throw new Error("Database not initialized");

        await this.db.run("BEGIN TRANSACTION");
        
        try {
            // Delete existing messages for this channel that aren't in the cache
            const messageIds = cache.messages.map(msg => msg.id);
            await this.db.run(
                "DELETE FROM messages WHERE channel_id = ? AND id NOT IN (?)",
                channelId,
                messageIds.join(",")
            );
            
            // Insert or update messages and their images
            for (const message of cache.messages) {
                await this.db.run(
                    `INSERT OR REPLACE INTO messages 
                    (id, channel_id, content, author_id, author_name, timestamp, referenced_message_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    message.id,
                    channelId,
                    message.content,
                    message.authorId,
                    message.authorName,
                    message.timestamp.getTime(),
                    message.referencedMessage
                );

                // Handle image analyses
                if (message.images.length > 0) {
                    await this.db.run("DELETE FROM image_analyses WHERE message_id = ?", message.id);
                    
                    for (const image of message.images) {
                        await this.db.run(
                            `INSERT INTO image_analyses 
                            (message_id, url, light_analysis, detailed_analysis)
                            VALUES (?, ?, ?, ?)`,
                            message.id,
                            image.url,
                            image.lightAnalysis,
                            image.detailedAnalysis
                        );
                    }
                }
            }
            
            await this.db.run("COMMIT");
        } catch (error) {
            await this.db.run("ROLLBACK");
            throw error;
        }
    }

    public async getChannelCache(channelId: string): Promise<ChannelCache | undefined> {
        if (!this.db) throw new Error("Database not initialized");
        
        try {
            const messages = await this.db.all<any[]>(
                `SELECT m.*, 
                        GROUP_CONCAT(ia.url) as urls,
                        GROUP_CONCAT(ia.light_analysis) as light_analyses,
                        GROUP_CONCAT(ia.detailed_analysis) as detailed_analyses
                 FROM messages m
                 LEFT JOIN image_analyses ia ON m.id = ia.message_id
                 WHERE m.channel_id = ?
                 GROUP BY m.id
                 ORDER BY m.timestamp DESC
                 LIMIT 100`,
                channelId
            );

            if (!messages || messages.length === 0) {
                logger.debug({ channelId }, "No cached messages found for channel");
                return { messages: [] };
            }

            logger.info({ 
                channelId, 
                messageCount: messages.length 
            }, "Retrieved cached messages from database");

            return {
                messages: messages.map(msg => ({
                    id: msg.id,
                    content: msg.content,
                    authorId: msg.author_id,
                    authorName: msg.author_name,
                    timestamp: new Date(msg.timestamp),
                    referencedMessage: msg.referenced_message_id,
                    images: this.parseImageAnalyses(msg)
                }))
            };
        } catch (error) {
            logger.error({ error, channelId }, "Error retrieving channel cache");
            return { messages: [] };
        }
    }

    private parseImageAnalyses(messageRow: any): ImageAnalysis[] {
        if (!messageRow.urls) return [];

        const urls = messageRow.urls.split(",");
        const lightAnalyses = messageRow.light_analyses.split(",");
        const detailedAnalyses = messageRow.detailed_analyses?.split(",");

        return urls.map((url: string, index: number) => ({
            url,
            lightAnalysis: lightAnalyses[index],
            detailedAnalysis: detailedAnalyses?.[index]
        }));
    }

    public async deleteChannelCache(channelId: string): Promise<void> {
        if (!this.db) throw new Error("Database not initialized");
        await this.db.run("DELETE FROM messages WHERE channel_id = ?", channelId);
    }
} 