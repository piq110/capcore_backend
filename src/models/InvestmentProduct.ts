import mongoose, { Document, Schema } from 'mongoose';

export interface IDocument {
  name: string;
  url: string;
  type: 'prospectus' | 'annual_report' | 'quarterly_report' | 'offering_circular' | 'other';
  uploadedAt: Date;
}

export interface IFeeStructure {
  managementFee: number; // Annual percentage
  performanceFee: number; // Percentage of profits
  acquisitionFee: number; // Percentage of acquisition cost
  dispositionFee: number; // Percentage of sale proceeds
}

export interface IOverviewData {
  totalInvestments?: number;
  floatingRatePercentage?: number;
  totalValue?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  navPerShare?: number;
  eps?: number;
  lastSalePrice?: number;
  contactWebsite?: string;
  contactPhone?: string;
  portfolioAllocation?: {
    seniorSecuredLoans?: number;
    preferredEquity?: number;
    seniorSecuredBonds?: number;
    other?: number;
  };
}

export interface IInvestmentProduct extends Document {
  name: string;
  symbol: string;
  type: 'REIT' | 'BDC';
  description: string;
  strategy: string;
  sharePrice: number;
  totalShares: number;
  availableShares: number;
  minimumInvestment: number;
  fees: IFeeStructure;
  documents: IDocument[];
  status: 'active' | 'on_hold' | 'inactive';
  issuerId: mongoose.Types.ObjectId;
  cusip?: string;
  isin?: string;
  sector?: string;
  geography?: string;
  targetReturn?: number;
  distributionFrequency?: 'monthly' | 'quarterly' | 'annually';
  lastDistributionDate?: Date;
  nextDistributionDate?: Date;
  nav: number; // Net Asset Value
  navDate: Date;
  overviewData?: IOverviewData;
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  getMarketCap(): number;
  getAvailabilityPercentage(): number;
  isAvailableForTrading(): boolean;
  updateNAV(newNav: number): void;
}

const documentSchema = new Schema<IDocument>({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  url: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['prospectus', 'annual_report', 'quarterly_report', 'offering_circular', 'other'],
    required: true,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
});

const feeStructureSchema = new Schema<IFeeStructure>({
  managementFee: {
    type: Number,
    required: true,
    min: 0,
    max: 10, // Max 10% annual management fee
  },
  performanceFee: {
    type: Number,
    default: 0,
    min: 0,
    max: 50, // Max 50% performance fee
  },
  acquisitionFee: {
    type: Number,
    default: 0,
    min: 0,
    max: 5, // Max 5% acquisition fee
  },
  dispositionFee: {
    type: Number,
    default: 0,
    min: 0,
    max: 5, // Max 5% disposition fee
  },
});

const overviewDataSchema = new Schema<IOverviewData>({
  totalInvestments: {
    type: Number,
    min: 0,
  },
  floatingRatePercentage: {
    type: Number,
    min: 0,
    max: 100,
  },
  totalValue: {
    type: Number,
    min: 0,
  },
  totalAssets: {
    type: Number,
    min: 0,
  },
  totalLiabilities: {
    type: Number,
    min: 0,
  },
  navPerShare: {
    type: Number,
    min: 0,
  },
  eps: {
    type: Number,
  },
  lastSalePrice: {
    type: Number,
    min: 0,
  },
  contactWebsite: {
    type: String,
    trim: true,
  },
  contactPhone: {
    type: String,
    trim: true,
  },
  portfolioAllocation: {
    seniorSecuredLoans: {
      type: Number,
      min: 0,
      max: 100,
    },
    preferredEquity: {
      type: Number,
      min: 0,
      max: 100,
    },
    seniorSecuredBonds: {
      type: Number,
      min: 0,
      max: 100,
    },
    other: {
      type: Number,
      min: 0,
      max: 100,
    },
  },
});

const investmentProductSchema = new Schema<IInvestmentProduct>({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [200, 'Product name cannot exceed 200 characters'],
  },
  symbol: {
    type: String,
    required: [true, 'Product symbol is required'],
    unique: true,
    uppercase: true,
    trim: true,
    match: [/^[A-Z]{2,10}$/, 'Symbol must be 2-10 uppercase letters'],
    index: true,
  },
  type: {
    type: String,
    enum: ['REIT', 'BDC'],
    required: [true, 'Product type is required'],
    index: true,
  },
  description: {
    type: String,
    required: [true, 'Product description is required'],
    maxlength: [2000, 'Description cannot exceed 2000 characters'],
  },
  strategy: {
    type: String,
    required: [true, 'Investment strategy is required'],
    maxlength: [1000, 'Strategy cannot exceed 1000 characters'],
  },
  sharePrice: {
    type: Number,
    required: [true, 'Share price is required'],
    min: [0.01, 'Share price must be at least $0.01'],
    max: [10000, 'Share price cannot exceed $10,000'],
  },
  totalShares: {
    type: Number,
    required: [true, 'Total shares is required'],
    min: [1, 'Total shares must be at least 1'],
  },
  availableShares: {
    type: Number,
    required: [true, 'Available shares is required'],
    min: [0, 'Available shares cannot be negative'],
  },
  minimumInvestment: {
    type: Number,
    required: [true, 'Minimum investment is required'],
    min: [1, 'Minimum investment must be at least $1'],
    default: 1000,
  },
  fees: {
    type: feeStructureSchema,
    required: true,
  },
  documents: [documentSchema],
  status: {
    type: String,
    enum: ['active', 'on_hold', 'inactive'],
    default: 'on_hold',
    index: true,
  },
  issuerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  cusip: {
    type: String,
    sparse: true,
    match: [/^[0-9A-Z]{9}$/, 'CUSIP must be 9 alphanumeric characters'],
  },
  isin: {
    type: String,
    sparse: true,
    match: [/^[A-Z]{2}[0-9A-Z]{9}[0-9]$/, 'ISIN must be 12 characters (2 letters + 9 alphanumeric + 1 digit)'],
  },
  sector: {
    type: String,
    trim: true,
  },
  geography: {
    type: String,
    trim: true,
  },
  targetReturn: {
    type: Number,
    min: 0,
    max: 100, // Max 100% target return
  },
  distributionFrequency: {
    type: String,
    enum: ['monthly', 'quarterly', 'annually'],
  },
  lastDistributionDate: {
    type: Date,
  },
  nextDistributionDate: {
    type: Date,
  },
  nav: {
    type: Number,
    required: [true, 'NAV is required'],
    min: [0.01, 'NAV must be at least $0.01'],
  },
  navDate: {
    type: Date,
    required: [true, 'NAV date is required'],
    default: Date.now,
  },
  overviewData: {
    type: overviewDataSchema,
    default: {},
  },
}, {
  timestamps: true,
});

// Indexes for performance
investmentProductSchema.index({ symbol: 1 });
investmentProductSchema.index({ type: 1 });
investmentProductSchema.index({ status: 1 });
investmentProductSchema.index({ issuerId: 1 });
investmentProductSchema.index({ sharePrice: 1 });
investmentProductSchema.index({ createdAt: -1 });
investmentProductSchema.index({ sector: 1 });
investmentProductSchema.index({ geography: 1 });

// Compound indexes
investmentProductSchema.index({ type: 1, status: 1 });
investmentProductSchema.index({ status: 1, sharePrice: 1 });

// Validation: availableShares cannot exceed totalShares
investmentProductSchema.pre('save', function(next) {
  if (this.availableShares > this.totalShares) {
    next(new Error('Available shares cannot exceed total shares'));
  } else {
    next();
  }
});

// Post-save hook to update portfolios when share price changes
investmentProductSchema.post('save', async function(doc) {
  try {
    // Check if sharePrice was modified
    if (this.isModified('sharePrice')) {
      // Import Portfolio model (avoid circular dependency)
      const { Portfolio } = await import('./Portfolio');
      
      // Find all portfolios that hold this product
      const portfolios = await Portfolio.find({
        'holdings.productId': doc._id
      });
      
      // Update prices for each portfolio
      for (const portfolio of portfolios) {
        portfolio.updatePrices([{
          productId: doc._id as mongoose.Types.ObjectId,
          price: doc.sharePrice
        }]);
        await portfolio.save();
      }
      
      console.log(`Updated ${portfolios.length} portfolios for product ${doc.symbol} price change to $${doc.sharePrice}`);
    }
  } catch (error) {
    console.error('Error updating portfolios after price change:', error);
    // Don't fail the product save if portfolio update fails
  }
});

// Instance method to get market capitalization
investmentProductSchema.methods.getMarketCap = function(): number {
  return this.totalShares * this.sharePrice;
};

// Instance method to get availability percentage
investmentProductSchema.methods.getAvailabilityPercentage = function(): number {
  if (this.totalShares === 0) return 0;
  return (this.availableShares / this.totalShares) * 100;
};

// Instance method to check if product is available for trading
investmentProductSchema.methods.isAvailableForTrading = function(): boolean {
  return this.status === 'active' && this.availableShares > 0;
};

// Instance method to update NAV
investmentProductSchema.methods.updateNAV = function(newNav: number): void {
  this.nav = newNav;
  this.navDate = new Date();
};

export const InvestmentProduct = mongoose.model<IInvestmentProduct>('InvestmentProduct', investmentProductSchema);