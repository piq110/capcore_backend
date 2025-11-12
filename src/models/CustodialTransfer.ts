import mongoose, { Document, Schema } from 'mongoose';

export interface ICustodialTransfer extends Document {
  tradeId: mongoose.Types.ObjectId;
  transferId: string; // External custodian transfer ID
  fromUserId: mongoose.Types.ObjectId;
  toUserId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantity: number;
  transferType: 'buy' | 'sell' | 'transfer';
  status: 'pending' | 'submitted' | 'confirmed' | 'settled' | 'failed' | 'cancelled';
  custodianReference: string;
  submittedAt?: Date;
  confirmedAt?: Date;
  settledAt?: Date;
  failedAt?: Date;
  failureReason?: string;
  metadata: {
    custodianName: string;
    accountNumbers: {
      from?: string;
      to?: string;
    };
    instructions?: string;
    fees?: number;
  };
  createdAt: Date;
  updatedAt: Date;

  // Methods
  submit(): void;
  confirm(): void;
  settle(): void;
  fail(reason: string): void;
  cancel(): void;
  isSettleable(): boolean;
}

const custodialTransferSchema = new Schema<ICustodialTransfer>({
  tradeId: {
    type: Schema.Types.ObjectId,
    ref: 'Trade',
    required: true,
    index: true,
  },
  transferId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  fromUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  toUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  productId: {
    type: Schema.Types.ObjectId,
    ref: 'InvestmentProduct',
    required: true,
    index: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: Number.isInteger,
      message: 'Quantity must be a whole number',
    },
  },
  transferType: {
    type: String,
    enum: ['buy', 'sell', 'transfer'],
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'submitted', 'confirmed', 'settled', 'failed', 'cancelled'],
    default: 'pending',
    index: true,
  },
  custodianReference: {
    type: String,
    required: true,
    index: true,
  },
  submittedAt: {
    type: Date,
    index: true,
  },
  confirmedAt: {
    type: Date,
    index: true,
  },
  settledAt: {
    type: Date,
    index: true,
  },
  failedAt: {
    type: Date,
  },
  failureReason: {
    type: String,
    maxlength: [500, 'Failure reason cannot exceed 500 characters'],
  },
  metadata: {
    custodianName: {
      type: String,
      required: true,
    },
    accountNumbers: {
      from: String,
      to: String,
    },
    instructions: String,
    fees: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
}, {
  timestamps: true,
});

// Indexes for performance
custodialTransferSchema.index({ tradeId: 1 });
custodialTransferSchema.index({ transferId: 1 });
custodialTransferSchema.index({ status: 1 });
custodialTransferSchema.index({ fromUserId: 1 });
custodialTransferSchema.index({ toUserId: 1 });
custodialTransferSchema.index({ productId: 1 });
custodialTransferSchema.index({ custodianReference: 1 });
custodialTransferSchema.index({ createdAt: -1 });

// Compound indexes
custodialTransferSchema.index({ status: 1, createdAt: -1 });
custodialTransferSchema.index({ productId: 1, status: 1 });
custodialTransferSchema.index({ fromUserId: 1, status: 1 });
custodialTransferSchema.index({ toUserId: 1, status: 1 });

// Instance method to submit transfer to custodian
custodialTransferSchema.methods.submit = function(): void {
  if (this.status !== 'pending') {
    throw new Error('Transfer can only be submitted from pending status');
  }
  
  this.status = 'submitted';
  this.submittedAt = new Date();
};

// Instance method to confirm transfer with custodian
custodialTransferSchema.methods.confirm = function(): void {
  if (this.status !== 'submitted') {
    throw new Error('Transfer can only be confirmed from submitted status');
  }
  
  this.status = 'confirmed';
  this.confirmedAt = new Date();
};

// Instance method to settle transfer
custodialTransferSchema.methods.settle = function(): void {
  if (this.status !== 'confirmed') {
    throw new Error('Transfer can only be settled from confirmed status');
  }
  
  this.status = 'settled';
  this.settledAt = new Date();
};

// Instance method to fail transfer
custodialTransferSchema.methods.fail = function(reason: string): void {
  if (this.status === 'settled') {
    throw new Error('Cannot fail a settled transfer');
  }
  
  this.status = 'failed';
  this.failedAt = new Date();
  this.failureReason = reason;
};

// Instance method to cancel transfer
custodialTransferSchema.methods.cancel = function(): void {
  if (['settled', 'failed'].includes(this.status)) {
    throw new Error('Cannot cancel a settled or failed transfer');
  }
  
  this.status = 'cancelled';
};

// Instance method to check if transfer is settleable
custodialTransferSchema.methods.isSettleable = function(): boolean {
  return this.status === 'confirmed';
};

export const CustodialTransfer = mongoose.model<ICustodialTransfer>('CustodialTransfer', custodialTransferSchema);