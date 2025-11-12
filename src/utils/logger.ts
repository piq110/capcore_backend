import winston from 'winston';
import config from '@/config';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.dirname(config.logging.file);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for structured logging
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss',
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const logEntry: any = {
      timestamp,
      level,
      message,
    };
    
    if (stack) {
      logEntry.stack = stack;
    }
    
    if (Object.keys(meta).length > 0) {
      logEntry.meta = meta;
    }
    
    return JSON.stringify(logEntry);
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss',
  }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return `${timestamp} [${level}]: ${message}${stack ? `\n${stack}` : ''}`;
  })
);

// Create transports array
const transports: winston.transport[] = [
  // File transport for all logs
  new winston.transports.File({
    filename: config.logging.file,
    level: config.logging.level,
    format: logFormat,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    tailable: true,
  }),
  
  // Separate file for errors
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    format: logFormat,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    tailable: true,
  }),
];

// Add console transport for development
if (config.nodeEnv === 'development') {
  transports.push(
    new winston.transports.Console({
      level: 'debug',
      format: consoleFormat,
    })
  );
}

// Create logger instance
export const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports,
  exitOnError: false,
});

// Create audit logger for financial transactions
export const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'audit.log'),
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 10,
      tailable: true,
    }),
  ],
});

// Security logger for authentication and authorization events
export const securityLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'security.log'),
      maxsize: 20 * 1024 * 1024, // 20MB
      maxFiles: 10,
      tailable: true,
    }),
  ],
});

// Helper functions for structured logging
export const logWithContext = (level: string, message: string, context: Record<string, any> = {}) => {
  logger.log(level, message, context);
};

export const logError = (error: Error, context: Record<string, any> = {}) => {
  logger.error(error.message, {
    stack: error.stack,
    name: error.name,
    ...context,
  });
};

export const logAudit = (action: string, userId: string, details: Record<string, any> = {}) => {
  auditLogger.info('Audit Event', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...details,
  });
};

export const logSecurity = (event: string, details: Record<string, any> = {}) => {
  securityLogger.info('Security Event', {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
};