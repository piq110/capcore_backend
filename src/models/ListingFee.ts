import mongoose, { Document, Schema } from 'mongoose';

export interface IListingFee extends Document {
  issuerId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  feeType: 'initial_listing' | 'annual_maintenance';
  amount: number;
  currency: string;
  dueDate: Date;
  paidDate?: Date;
  status: 'pending' | 'paid' | 'overdue' | 'waived';
  paymentMethod?: 'crypto' | 'bank_transfer' | 'credit_card';
  transactionId?: string; // External payment transaction ID
  billingPeriod?: {
    startDate: Date;
    endDate: Date;
  };
  metadata?: {
    invoiceNumber?: string;
    notes?: string;
    [key: string]: any;
  };
  createdAt: Date;
  updatedAt: Date;

  // Methods
  markAsPaid(transactionId?: string, paymentMethod?: string): Promise<void>;
  markAsOverdue(): Promise<void>;
  waiveFee(reason: string): Promise<void>;
  generateInvoice(): Promise<string>;
}

const listingFeeSchema = new Schema<IListingFee>({
  issuerId: {
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
  feeType: {
    type: String,
    enum: ['initial_listing', 'annual_maintenance'],
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    required: true,
    default: 'USD',
  },
  dueDate: {
    type: Date,
    required: true,
    index: true,
  },
  paidDate: {
    type: Date,
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'overdue', 'waived'],
    default: 'pending',
    index: true,
  },
  paymentMethod: {
    type: String,
    enum: ['crypto', 'bank_transfer', 'credit_card'],
  },
  transactionId: {
    type: String,
  },
  billingPeriod: {
    startDate: { type: Date },
    endDate: { type: Date },
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

// Indexes
listingFeeSchema.index({ issuerId: 1, status: 1 });
listingFeeSchema.index({ productId: 1, feeType: 1 });
listingFeeSchema.index({ status: 1, dueDate: 1 });
listingFeeSchema.index({ feeType: 1, createdAt: -1 });

// Instance method to mark as paid
listingFeeSchema.methods.markAsPaid = async function(transactionId?: string, paymentMethod?: string): Promise<void> {
  if (this.status === 'paid') {
    throw new Error('Fee is already marked as paid');
  }
  
  this.status = 'paid';
  this.paidDate = new Date();
  if (transactionId) this.transactionId = transactionId;
  if (paymentMethod) this.paymentMethod = paymentMethod;
  
  await this.save();
};

// Instance method to mark as overdue
listingFeeSchema.methods.markAsOverdue = async function(): Promise<void> {
  if (this.status !== 'pending') {
    throw new Error(`Cannot mark fee as overdue with status: ${this.status}`);
  }
  
  this.status = 'overdue';
  await this.save();
};

// Instance method to waive fee
listingFeeSchema.methods.waiveFee = async function(reason: string): Promise<void> {
  if (this.status === 'paid') {
    throw new Error('Cannot waive a fee that has already been paid');
  }
  
  this.status = 'waived';
  this.metadata = { ...this.metadata, waivedReason: reason, waivedAt: new Date() };
  await this.save();
};

// Instance method to generate invoice
listingFeeSchema.methods.generateInvoice = async function(): Promise<string> {
  const invoiceNumber = `INV-${this.feeType.toUpperCase()}-${Date.now()}`;
  this.metadata = { ...this.metadata, invoiceNumber };
  await this.save();
  return invoiceNumber;
};

// Static method to check for overdue fees
listingFeeSchema.statics.markOverdueFees = async function() {
  const overdueDate = new Date();
  await this.updateMany(
    {
      status: 'pending',
      dueDate: { $lt: overdueDate }
    },
    {
      $set: { status: 'overdue' }
    }
  );
};

export const ListingFee = mongoose.model<IListingFee>('ListingFee', listingFeeSchema);