import mongoose, { Document, Schema } from 'mongoose';

export interface IWalletAddress {
  ethereum: string;
  tron: string;
  bsc: string;
}

export interface IEncryptedPrivateKey {
  encryptedKey: string;
  iv: string;
}

export interface IWalletPrivateKeys {
  ethereum: IEncryptedPrivateKey;
  tron: IEncryptedPrivateKey;
  bsc: IEncryptedPrivateKey;
}

export interface ITokenBalance {
  ethereum: number;
  tron: number;
  bsc: number;
}

export interface IWalletBalances {
  usdt: ITokenBalance;
  usdc: ITokenBalance;
}

export interface IWallet extends Document {
  userId: mongoose.Types.ObjectId;
  addresses: IWalletAddress;
  privateKeys: IWalletPrivateKeys;
  balances: IWalletBalances;
  totalBalanceUSD: number;
  lastSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  getTotalBalance(): number;
  getTotalBalanceUSD(): number;
  getNetworkBalance(network: 'ethereum' | 'tron' | 'bsc'): number;
  updateBalance(network: 'ethereum' | 'tron' | 'bsc', token: 'usdt' | 'usdc', amount: number): void;
}

const walletSchema = new Schema<IWallet>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  addresses: {
    ethereum: {
      type: String,
      required: true,
      match: [/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format'],
    },
    tron: {
      type: String,
      required: true,
      match: [/^T[A-Za-z0-9]{33}$/, 'Invalid Tron address format'],
    },
    bsc: {
      type: String,
      required: true,
      match: [/^0x[a-fA-F0-9]{40}$/, 'Invalid BSC address format'],
    },
  },
  privateKeys: {
    ethereum: {
      encryptedKey: {
        type: String,
        required: true,
        select: false, // Don't include in queries by default
      },
      iv: {
        type: String,
        required: true,
        select: false,
      },
    },
    tron: {
      encryptedKey: {
        type: String,
        required: true,
        select: false,
      },
      iv: {
        type: String,
        required: true,
        select: false,
      },
    },
    bsc: {
      encryptedKey: {
        type: String,
        required: true,
        select: false,
      },
      iv: {
        type: String,
        required: true,
        select: false,
      },
    },
  },
  balances: {
    usdt: {
      ethereum: {
        type: Number,
        default: 0,
        min: 0,
      },
      tron: {
        type: Number,
        default: 0,
        min: 0,
      },
      bsc: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    usdc: {
      ethereum: {
        type: Number,
        default: 0,
        min: 0,
      },
      tron: {
        type: Number,
        default: 0,
        min: 0,
      },
      bsc: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
  },
  totalBalanceUSD: {
    type: Number,
    default: 0,
    min: 0,
  },
  lastSyncAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Indexes for performance
walletSchema.index({ userId: 1 });
walletSchema.index({ 'addresses.ethereum': 1 });
walletSchema.index({ 'addresses.tron': 1 });
walletSchema.index({ 'addresses.bsc': 1 });
walletSchema.index({ totalBalanceUSD: -1 });
walletSchema.index({ lastSyncAt: -1 });

// Instance method to get total balance across all networks and tokens
walletSchema.methods.getTotalBalance = function(): number {
  const { usdt, usdc } = this.balances;
  return (
    usdt.ethereum + usdt.tron + usdt.bsc +
    usdc.ethereum + usdc.tron + usdc.bsc
  );
};

// Instance method to get total balance in USD (same as getTotalBalance since USDT/USDC are USD stablecoins)
walletSchema.methods.getTotalBalanceUSD = function(): number {
  return this.getTotalBalance();
};

// Instance method to get balance for a specific network
walletSchema.methods.getNetworkBalance = function(network: 'ethereum' | 'tron' | 'bsc'): number {
  const { usdt, usdc } = this.balances;
  return usdt[network] + usdc[network];
};

// Instance method to update balance for a specific network and token
walletSchema.methods.updateBalance = function(
  network: 'ethereum' | 'tron' | 'bsc',
  token: 'usdt' | 'usdc',
  amount: number
): void {
  this.balances[token][network] = Math.max(0, amount);
  this.totalBalanceUSD = this.getTotalBalance();
  this.lastSyncAt = new Date();
};

// Pre-save middleware to update total balance
walletSchema.pre('save', function(next) {
  this.totalBalanceUSD = this.getTotalBalance();
  next();
});

export const Wallet = mongoose.model<IWallet>('Wallet', walletSchema);