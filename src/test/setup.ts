// Jest setup file for backend tests
import { logger } from '../utils/logger';

// Suppress logs during testing
logger.silent = true;

// Set test timeout
jest.setTimeout(10000);

// Clean up after tests
afterAll(async () => {
  // Close any open handles
  await new Promise(resolve => setTimeout(resolve, 100));
});