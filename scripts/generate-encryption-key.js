#!/usr/bin/env node

/**
 * Generate a secure encryption key for wallet private key storage
 * 
 * Usage: node scripts/generate-encryption-key.js
 */

const crypto = require('crypto');

console.log('\n==============================================');
console.log('  Wallet Encryption Key Generator');
console.log('==============================================\n');

const encryptionKey = crypto.randomBytes(32).toString('hex');

console.log('Generated Encryption Key:');
console.log('');
console.log(encryptionKey);
console.log('');
console.log('Add this to your .env file:');
console.log('');
console.log(`WALLET_ENCRYPTION_KEY=${encryptionKey}`);
console.log('');
console.log('⚠️  IMPORTANT SECURITY NOTES:');
console.log('  1. Store this key securely - losing it means losing access to all wallet private keys');
console.log('  2. Never commit this key to version control');
console.log('  3. Use different keys for development and production');
console.log('  4. Back up this key in a secure location (password manager, vault, etc.)');
console.log('  5. Rotate this key periodically in production');
console.log('');
console.log('==============================================\n');
