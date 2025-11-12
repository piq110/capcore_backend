import mongoose from 'mongoose';
import config from '@/config';
import { logger } from '@/utils/logger';

class DatabaseConnection {
  private static instance: DatabaseConnection;
  private isConnected: boolean = false;

  private constructor() {}

  public static getInstance(): DatabaseConnection {
    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = new DatabaseConnection();
    }
    return DatabaseConnection.instance;
  }

  public async connect(): Promise<void> {
    if (this.isConnected) {
      logger.info('Database already connected');
      return;
    }

    try {
      // Configure mongoose options
      const options = {
        maxPoolSize: 10, // Maintain up to 10 socket connections
        serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
        socketTimeoutMS: 45000, // Close sockets after 45 seconds
        bufferCommands: false, // Disable mongoose buffering
      };

      await mongoose.connect(config.mongodb.uri, options);
      
      this.isConnected = true;
      logger.info('Successfully connected to MongoDB', {
        uri: config.mongodb.uri.replace(/\/\/.*@/, '//***:***@'), // Hide credentials in logs
      });

      // Handle connection events
      mongoose.connection.on('error', (error) => {
        logger.error('MongoDB connection error:', error);
        this.isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('MongoDB disconnected');
        this.isConnected = false;
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected');
        this.isConnected = true;
      });

    } catch (error) {
      logger.error('Failed to connect to MongoDB:', error);
      this.isConnected = false;
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.disconnect();
      this.isConnected = false;
      logger.info('Disconnected from MongoDB');
    } catch (error) {
      logger.error('Error disconnecting from MongoDB:', error);
      throw error;
    }
  }

  public isConnectionActive(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  public getConnection(): typeof mongoose.connection {
    return mongoose.connection;
  }
}

// Export singleton instance
export const database = DatabaseConnection.getInstance();

// Helper function for graceful shutdown
export const gracefulShutdown = async (): Promise<void> => {
  try {
    await database.disconnect();
    logger.info('Database connection closed through app termination');
  } catch (error) {
    logger.error('Error during database shutdown:', error);
  }
};