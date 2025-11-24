import mongoose, { Document, Schema } from 'mongoose';

export interface ITrade extends Document {
  buyOrderId: mongoose.Types.ObjectId;
  sellOrderId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantity: number;
  pricePerShare: number;
  totalAmount: number;
  buyerFees: number;
  sellerFees: number;
  status: 'pending' | 'settled' | 'failed';
  executedAt: Date;
  settledAt?: Date;
  failedAt?: Date;
  failureReason?: string;
  custodialTransferId?: string;
  custodialStatus?: 'pending' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;

  // Methods
  getTotalFees(): number;
  getNetAmount(): number;
  canSettle(): boolean;
  settle(): void;
  fail(reason: string): void;
}

const tradeSchema = new Schema<ITrade>({
  buyOrderId: {
    type: Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true,
  },
  sellOrderId: {
    type: Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true,
  },
  buyerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  sellerId: {
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
  pricePerShare: {
    type: Number,
    required: true,
    min: 0.01,
  },
  totalAmount: {
    type: Number,
    required: true,
    min: 0.01,
  },
  buyerFees: {
    type: Number,
    default: 0,
    min: 0,
  },
  sellerFees: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'settled', 'failed'],
    default: 'pending',
    index: true,
  },
  executedAt: {
    type: Date,
    default: Date.now,
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
  custodialTransferId: {
    type: String,
    index: true,
  },
  custodialStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    index: true,
  },
}, {
  timestamps: true,
});

// Indexes for performance
tradeSchema.index({ buyerId: 1 });
tradeSchema.index({ sellerId: 1 });
tradeSchema.index({ productId: 1 });
tradeSchema.index({ status: 1 });
tradeSchema.index({ executedAt: -1 });
tradeSchema.index({ settledAt: -1 });

// Compound indexes
tradeSchema.index({ buyerId: 1, status: 1, executedAt: -1 });
tradeSchema.index({ sellerId: 1, status: 1, executedAt: -1 });
tradeSchema.index({ productId: 1, status: 1, executedAt: -1 });
tradeSchema.index({ status: 1, executedAt: -1 });

// Pre-save middleware to calculate total amount
tradeSchema.pre('save', function(next) {
  if (!this.totalAmount || this.totalAmount === 0) {
    this.totalAmount = this.quantity * this.pricePerShare;
  }
  next();
});

// Instance method to get total fees
tradeSchema.methods.getTotalFees = function(): number {
  return this.buyerFees + this.sellerFees;
};

// Instance method to get net amount (total amount minus fees)
tradeSchema.methods.getNetAmount = function(): number {
  return this.totalAmount - this.getTotalFees();
};

// Instance method to check if trade can be settled
tradeSchema.methods.canSettle = function(): boolean {
  return this.status === 'pending';
};

// Instance method to settle trade
tradeSchema.methods.settle = function(): void {
  if (!this.canSettle()) {
    throw new Error('Trade cannot be settled in current status');
  }
  
  this.status = 'settled';
  this.settledAt = new Date();
};

// Instance method to fail trade
tradeSchema.methods.fail = function(reason: string): void {
  if (this.status === 'settled') {
    throw new Error('Cannot fail a settled trade');
  }
  
  this.status = 'failed';
  this.failedAt = new Date();
  this.failureReason = reason;
};

export const Trade = mongoose.model<ITrade>('Trade', tradeSchema);