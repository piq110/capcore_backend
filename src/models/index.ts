// Export all models
export { User, IUser } from './User';
export { Wallet, IWallet, IWalletAddress, ITokenBalance, IWalletBalances } from './Wallet';
export { InvestmentProduct, IInvestmentProduct, IDocument, IFeeStructure } from './InvestmentProduct';
export { Order, IOrder } from './Order';
export { Trade, ITrade } from './Trade';
export { Portfolio, IPortfolio, IHolding } from './Portfolio';
export { KYCSubmission, IKYCSubmission, IKYCDocument } from './KYC';
export { Transaction, ITransaction } from './Transaction';
export { Withdrawal, IWithdrawal } from './Withdrawal';
export { CustodialTransfer, ICustodialTransfer } from './CustodialTransfer';
export { ShareRegister, IShareRegisterEntry } from './ShareRegister';
export { AuditLog, IAuditLog, createAuditLog } from './AuditLog';
export { PlatformConfig, IPlatformConfig, IFeeConfig, ITradingRules, IWithdrawalLimits, ISystemSettings, getActiveConfig, createDefaultConfig } from './PlatformConfig';
export { FeeTransaction, IFeeTransaction } from './FeeTransaction';
export { ListingFee, IListingFee } from './ListingFee';

// Re-export mongoose for convenience
export { default as mongoose } from 'mongoose';