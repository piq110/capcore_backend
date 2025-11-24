import { Request, Response, NextFunction } from 'express';
import { logger } from '@/utils/logger';

interface RequestLogData {
  method: string;
  url: string;
  userAgent?: string;
  ip: string;
  userId?: string;
  statusCode?: number;
  responseTime?: number;
  contentLength?: number;
}

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now();
  
  // Capture original end function
  const originalEnd = res.end;
  
  // Override end function to log response
  res.end = function(chunk?: any, encoding?: any) {
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    const logData: RequestLogData = {
      method: req.method,
      url: req.originalUrl,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress || 'unknown',
      userId: (req as any).user?.id,
      statusCode: res.statusCode,
      responseTime,
      contentLength: res.get('Content-Length') ? parseInt(res.get('Content-Length')!, 10) : undefined,
    };

    // Determine log level based on status code
    let logLevel = 'info';
    if (res.statusCode >= 400 && res.statusCode < 500) {
      logLevel = 'warn';
    } else if (res.statusCode >= 500) {
      logLevel = 'error';
    }

    // Skip logging for health checks in production
    if (req.originalUrl === '/health' && process.env.NODE_ENV === 'production') {
      return originalEnd.call(this, chunk, encoding);
    }

    // Log the request
    logger.log(logLevel, `${req.method} ${req.originalUrl} - ${res.statusCode} - ${responseTime}ms`, logData);
    
    // Call original end function
    return originalEnd.call(this, chunk, encoding);
  };
  
  next();
};