# Wallet Private Key Management

## Overview

The platform now securely stores encrypted private keys for all user wallets. This enables admins to manage user funds and process withdrawals directly from the admin dashboard.

## Security Architecture

### Encryption
- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Storage**: Master encryption key stored in environment variables
- **Per-Key IV**: Each private key uses a unique initialization vector
- **Database Storage**: Only encrypted keys are stored; never plaintext

### Access Control
- Private keys are excluded from normal database queries (`select: false`)
- Only admin users can access private key endpoints
- All access is logged to security logs with admin ID, IP address, and timestamp

## Setup

### 1. Generate Encryption Key

Run the key generation script:

```bash
node scripts/generate-encryption-key.js
```

This will output a secure 64-character hex string.

### 2. Configure Environment

Add the generated key to your `.env` file:

```bash
WALLET_ENCRYPTION_KEY=your_generated_64_character_hex_key_here
```

⚠️ **CRITICAL**: Never commit this key to version control!

### 3. Restart Application

Restart your application for the changes to take effect:

```bash
npm run dev  # or your start command
```

## Admin Dashboard Usage

### View All Wallets

**Endpoint**: `GET /api/admin/wallets`

**Query Parameters**:
- `page` (optional): Page number (default: 1)
- `limit` (optional): Results per page (default: 20, max: 100)
- `search` (optional): Search by wallet address

**Example**:
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  "https://your-api.com/api/admin/wallets?page=1&limit=20"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "wallets": [
      {
        "_id": "wallet_id",
        "userId": {
          "email": "user@example.com",
          "firstName": "John",
          "lastName": "Doe",
          "kycStatus": "approved"
        },
        "addresses": {
          "ethereum": "0x...",
          "tron": "T...",
          "bsc": "0x..."
        },
        "balances": {
          "usdt": { "ethereum": 100, "tron": 50, "bsc": 75 },
          "usdc": { "ethereum": 0, "tron": 0, "bsc": 0 }
        },
        "totalBalanceUSD": 225
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "pages": 8
    }
  }
}
```

### View Encrypted Private Keys

**Endpoint**: `GET /api/admin/wallets/:walletId/private-keys`

**Example**:
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  "https://your-api.com/api/admin/wallets/WALLET_ID/private-keys"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "walletId": "wallet_id",
    "userId": "user_id",
    "addresses": {
      "ethereum": "0x...",
      "tron": "T...",
      "bsc": "0x..."
    },
    "privateKeys": {
      "ethereum": {
        "encryptedKey": "encrypted_hex_string...",
        "iv": "initialization_vector_hex..."
      },
      "tron": {
        "encryptedKey": "encrypted_hex_string...",
        "iv": "initialization_vector_hex..."
      },
      "bsc": {
        "encryptedKey": "encrypted_hex_string...",
        "iv": "initialization_vector_hex..."
      }
    },
    "warning": "These are encrypted private keys. Use the decryption endpoint or decrypt manually with the master encryption key."
  }
}
```

### Decrypt Private Key

**Endpoint**: `POST /api/admin/wallets/:walletId/decrypt-private-key`

**Body**:
```json
{
  "network": "ethereum"  // or "tron" or "bsc"
}
```

**Example**:
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"network":"ethereum"}' \
  "https://your-api.com/api/admin/wallets/WALLET_ID/decrypt-private-key"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "walletId": "wallet_id",
    "userId": "user_id",
    "network": "ethereum",
    "address": "0x...",
    "privateKey": "0x1234567890abcdef...",
    "warning": "CRITICAL: This is the unencrypted private key. Handle with extreme care. Never share or log this value."
  }
}
```

⚠️ **WARNING**: The decrypted private key gives full control over the wallet. Handle with extreme care!

## Using Private Keys for Withdrawals

### Manual Withdrawal Process

1. **Get the withdrawal request** from the admin dashboard
2. **Decrypt the private key** for the user's wallet on the appropriate network
3. **Use Web3/TronWeb** to sign and send the transaction:

#### Ethereum/BSC Example:
```javascript
const Web3 = require('web3');
const web3 = new Web3('https://mainnet.infura.io/v3/YOUR_KEY');

// Get private key from admin endpoint
const privateKey = '0x...'; // From decrypt endpoint

// Create account from private key
const account = web3.eth.accounts.privateKeyToAccount(privateKey);

// Send transaction
const tx = {
  from: account.address,
  to: '0xRECIPIENT_ADDRESS',
  value: web3.utils.toWei('0', 'ether'), // 0 ETH (we're sending tokens)
  gas: 100000,
  // Add token transfer data here for USDT/USDC
};

const signedTx = await account.signTransaction(tx);
const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
```

#### Tron Example:
```javascript
const TronWeb = require('tronweb');
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  privateKey: 'YOUR_PRIVATE_KEY' // From decrypt endpoint
});

// Send TRC20 token (USDT)
const contract = await tronWeb.contract().at('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
const result = await contract.transfer(
  'RECIPIENT_ADDRESS',
  amount * 1000000 // USDT has 6 decimals
).send();
```

## Gas Fee Management

### The Gas Problem

User wallets need native tokens (ETH, BNB, TRX) to pay for transaction fees when withdrawing USDT/USDC.

### Solutions

1. **Manual Gas Funding** (Current):
   - Admin manually sends gas tokens to user wallets before processing withdrawals
   - Use MetaMask or other wallet to send small amounts of ETH/BNB/TRX

2. **Automated Sweeper** (Recommended - Future Implementation):
   - Automatically detect deposits
   - Send gas tokens from master wallet
   - Sweep tokens to master wallet
   - Process withdrawals from master wallet

## Security Best Practices

### For Admins

1. **Never share decrypted private keys** via email, chat, or any insecure channel
2. **Use the decrypt endpoint only when necessary** for processing withdrawals
3. **Clear your browser cache** after viewing private keys
4. **Use a secure, private network** when accessing private keys
5. **Enable 2FA** on your admin account
6. **Log out** after completing sensitive operations

### For Platform Operators

1. **Rotate encryption keys** periodically (requires re-encrypting all keys)
2. **Monitor security logs** for unauthorized access attempts
3. **Backup encryption keys** securely (password manager, hardware vault)
4. **Use HSM** (Hardware Security Module) in production for key storage
5. **Implement IP whitelisting** for admin endpoints
6. **Set up alerts** for private key access events
7. **Regular security audits** of wallet management code

## Audit Logging

All private key access is logged to `logs/security.log`:

```json
{
  "level": "warn",
  "message": "Admin accessed wallet private keys",
  "adminId": "admin_user_id",
  "adminEmail": "admin@example.com",
  "walletId": "wallet_id",
  "userId": "user_id",
  "ipAddress": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Review these logs regularly for suspicious activity.

## Troubleshooting

### "Private key decryption failed"

**Cause**: Wrong encryption key or corrupted data

**Solution**:
1. Verify `WALLET_ENCRYPTION_KEY` in `.env` matches the key used during wallet creation
2. Check if the wallet was created before encryption was implemented
3. Regenerate the wallet if necessary (user will need to deposit again)

### "Insufficient gas for transaction"

**Cause**: User wallet has no ETH/BNB/TRX for gas fees

**Solution**:
1. Send small amount of native token to user's wallet:
   - Ethereum: 0.001-0.01 ETH
   - BSC: 0.001-0.01 BNB
   - Tron: 10-50 TRX
2. Wait for confirmation
3. Process withdrawal

### "Transaction failed"

**Possible causes**:
- Insufficient gas
- Network congestion
- Invalid recipient address
- Insufficient token balance

**Solution**:
1. Check blockchain explorer for transaction details
2. Verify all parameters (amount, address, gas)
3. Retry with higher gas price if needed

## Migration Guide

If you have existing wallets without private keys:

1. **Backup existing data**
2. **Generate new wallets** for affected users
3. **Notify users** to deposit to new addresses
4. **Deprecate old wallets** after migration period

## Future Enhancements

- [ ] Automated sweeper service
- [ ] Master wallet management
- [ ] Multi-signature withdrawals
- [ ] Hardware wallet integration
- [ ] Automated gas management
- [ ] Batch withdrawal processing
- [ ] Key rotation system

## Support

For issues or questions, contact the development team or refer to the main documentation.
