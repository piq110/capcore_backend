import { CustodianService, custodianService } from './CustodianService';
import { CustodialTransfer, ICustodialTransfer } from '@/models/CustodialTransfer';
import { ShareRegister, IShareRegisterEntry } from '@/models/ShareRegister';
import { Trade, ITrade } from '@/models/Trade';
import { User } from '@/models/User';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { Portfolio } from '@/models/Portfolio';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

export interface AssetTransferWorkflow {
  tradeId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantity: number;
  pricePerShare: number;
  status: 'initiated' | 'custodian_submitted' | 'custodian_confirmed' | 'ownership_updated' | 'completed' | 'failed';
  steps: {
    step: string;
    status: 'pending' | 'completed' | 'failed';
    completedAt?: Date;
    error?: string;
  }[];
  createdAt: Date;
  completedAt?: Date;
}

export interface OwnershipVerification {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  platformHoldings: number;
  custodianHoldings: number;
  shareRegisterEntries: IShareRegisterEntry[];
  isVerified: boolean;
  discrepancies: string[];
}

export interface AssetTransferSummary {
  totalTransfers: number;
  pendingTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  totalValue: number;
  averageSettlementTime: number; // in hours
}

export class AssetTransferService {
  private custodianService: CustodianService;

  constructor(custodianService: CustodianService) {
    this.custodianService = custodianService;
  }

  /**
   * Execute complete asset transfer workflow for a trade
   */
  async executeAssetTransfer(trade: ITrade): Promise<AssetTransferWorkflow> {
    const workflow: AssetTransferWorkflow = {
      tradeId: trade._id as mongoose.Types.ObjectId,
      buyerId: trade.buyerId,
      sellerId: trade.sellerId,
      productId: trade.productId,
      quantity: trade.quantity,
      pricePerShare: trade.pricePerShare,
      status: 'initiated',
      steps: [
        { step: 'validate_ownership', status: 'pending' },
        { step: 'initiate_custodial_transfer', status: 'pending' },
        { step: 'submit_to_custodian', status: 'pending' },
        { step: 'confirm_custodial_transfer', status: 'pending' },
        { step: 'update_share_register', status: 'pending' },
        { step: 'update_portfolios', status: 'pending' },
        { step: 'finalize_ownership', status: 'pending' },
      ],
      createdAt: new Date(),
    };

    try {
      // Step 1: Validate seller ownership
      await this.executeWorkflowStep(workflow, 'validate_ownership', async () => {
        await this.validateSellerOwnership(trade.sellerId, trade.productId, trade.quantity);
      });

      // Step 2: Initiate custodial transfer
      let custodialTransfer: ICustodialTransfer;
      await this.executeWorkflowStep(workflow, 'initiate_custodial_transfer', async () => {
        custodialTransfer = await this.custodianService.initiateShareTransfer(trade);
      });

      // Step 3: Submit to custodian
      await this.executeWorkflowStep(workflow, 'submit_to_custodian', async () => {
        await this.custodianService.submitTransferToCustodian(custodialTransfer!.transferId);
        workflow.status = 'custodian_submitted';
      });

      // Step 4: Confirm custodial transfer (this might be called later via webhook/polling)
      await this.executeWorkflowStep(workflow, 'confirm_custodial_transfer', async () => {
        await this.custodianService.confirmTransfer(custodialTransfer!.transferId);
        workflow.status = 'custodian_confirmed';
      });

      // Step 5: Update share register
      await this.executeWorkflowStep(workflow, 'update_share_register', async () => {
        await this.updateShareRegisterForTransfer(custodialTransfer!);
        workflow.status = 'ownership_updated';
      });

      // Step 6: Update portfolios
      await this.executeWorkflowStep(workflow, 'update_portfolios', async () => {
        await this.updatePortfoliosForTransfer(trade);
      });

      // Step 7: Finalize ownership
      await this.executeWorkflowStep(workflow, 'finalize_ownership', async () => {
        await this.custodianService.settleTransfer(custodialTransfer!.transferId);
      });

      workflow.status = 'completed';
      workflow.completedAt = new Date();

      logger.info('Asset transfer workflow completed', {
        tradeId: trade._id,
        transferId: custodialTransfer!.transferId,
        duration: workflow.completedAt.getTime() - workflow.createdAt.getTime(),
      });

      return workflow;

    } catch (error) {
      workflow.status = 'failed';
      logger.error('Asset transfer workflow failed:', error);
      throw error;
    }
  }

  /**
   * Validate that seller has sufficient ownership
   */
  async validateSellerOwnership(
    sellerId: mongoose.Types.ObjectId,
    productId: mongoose.Types.ObjectId,
    quantity: number
  ): Promise<void> {
    try {
      // Check platform portfolio
      const portfolio = await Portfolio.findOne({ userId: sellerId });
      const holding = portfolio?.getHolding(productId);

      if (!holding || holding.quantity < quantity) {
        throw new Error('Seller has insufficient shares in portfolio');
      }

      // Check share register
      const shareRegisterEntries = await ShareRegister.find({
        userId: sellerId,
        productId,
        status: 'active',
      });

      const totalRegisteredShares = shareRegisterEntries.reduce(
        (total, entry) => total + entry.quantity,
        0
      );

      if (totalRegisteredShares < quantity) {
        throw new Error('Seller has insufficient registered shares');
      }

      // Verify custodian holdings
      const verification = await this.verifyOwnership(sellerId, productId);
      if (!verification.isVerified) {
        throw new Error(`Ownership verification failed: ${verification.discrepancies.join(', ')}`);
      }

      logger.info('Seller ownership validated', {
        sellerId,
        productId,
        requestedQuantity: quantity,
        portfolioQuantity: holding.quantity,
        registeredQuantity: totalRegisteredShares,
        custodianQuantity: verification.custodianHoldings,
      });

    } catch (error) {
      logger.error('Seller ownership validation failed:', error);
      throw error;
    }
  }

  /**
   * Verify ownership across platform, share register, and custodian
   */
  async verifyOwnership(
    userId: mongoose.Types.ObjectId,
    productId: mongoose.Types.ObjectId
  ): Promise<OwnershipVerification> {
    try {
      const discrepancies: string[] = [];

      // Get platform holdings
      const portfolio = await Portfolio.findOne({ userId });
      const platformHoldings = portfolio?.getHolding(productId)?.quantity || 0;

      // Get share register entries
      const shareRegisterEntries = await ShareRegister.find({
        userId,
        productId,
        status: 'active',
      });

      const registeredHoldings = shareRegisterEntries.reduce(
        (total, entry) => total + entry.quantity,
        0
      );

      // Get custodian holdings (mock implementation)
      const custodianBalances = await this.custodianService.getCustodianBalances();
      const product = await InvestmentProduct.findById(productId);
      const custodianHoldings = custodianBalances
        .filter(balance => balance.productSymbol === product?.symbol)
        .reduce((total, balance) => total + balance.quantity, 0);

      // Check for discrepancies
      if (platformHoldings !== registeredHoldings) {
        discrepancies.push(
          `Platform holdings (${platformHoldings}) don't match share register (${registeredHoldings})`
        );
      }

      if (registeredHoldings !== custodianHoldings) {
        discrepancies.push(
          `Share register (${registeredHoldings}) doesn't match custodian holdings (${custodianHoldings})`
        );
      }

      const isVerified = discrepancies.length === 0;

      return {
        userId,
        productId,
        platformHoldings,
        custodianHoldings,
        shareRegisterEntries,
        isVerified,
        discrepancies,
      };

    } catch (error) {
      logger.error('Ownership verification failed:', error);
      throw error;
    }
  }

  /**
   * Update share register for completed transfer
   */
  async updateShareRegisterForTransfer(custodialTransfer: ICustodialTransfer): Promise<void> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // This is handled in the CustodianService.updateShareRegister method
      // but we can add additional validation and logging here

      const sellerEntries = await ShareRegister.find({
        userId: custodialTransfer.fromUserId,
        productId: custodialTransfer.productId,
        status: 'active',
      }).session(session);

      const buyerEntries = await ShareRegister.find({
        userId: custodialTransfer.toUserId,
        productId: custodialTransfer.productId,
        status: 'active',
      }).session(session);

      logger.info('Share register updated for transfer', {
        transferId: custodialTransfer.transferId,
        fromUserId: custodialTransfer.fromUserId,
        toUserId: custodialTransfer.toUserId,
        quantity: custodialTransfer.quantity,
        sellerEntriesCount: sellerEntries.length,
        buyerEntriesCount: buyerEntries.length,
      });

      await session.commitTransaction();

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to update share register for transfer:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Update portfolios after asset transfer
   */
  async updatePortfoliosForTransfer(trade: ITrade): Promise<void> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Update seller portfolio (remove shares)
      const sellerPortfolio = await Portfolio.findOne({ userId: trade.sellerId }).session(session);
      if (sellerPortfolio) {
        sellerPortfolio.updateHolding(trade.productId, -trade.quantity, trade.pricePerShare);
        await sellerPortfolio.save({ session });
      }

      // Update buyer portfolio (add shares)
      let buyerPortfolio = await Portfolio.findOne({ userId: trade.buyerId }).session(session);
      if (!buyerPortfolio) {
        buyerPortfolio = new Portfolio({
          userId: trade.buyerId,
          holdings: [],
          cashBalance: 0,
        });
      }
      buyerPortfolio.addHolding(trade.productId, trade.quantity, trade.pricePerShare);
      await buyerPortfolio.save({ session });

      await session.commitTransaction();

      logger.info('Portfolios updated for asset transfer', {
        tradeId: trade._id,
        sellerId: trade.sellerId,
        buyerId: trade.buyerId,
        quantity: trade.quantity,
        pricePerShare: trade.pricePerShare,
      });

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to update portfolios for transfer:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Get asset transfer summary for reporting
   */
  async getAssetTransferSummary(
    startDate?: Date,
    endDate?: Date,
    productId?: mongoose.Types.ObjectId
  ): Promise<AssetTransferSummary> {
    try {
      const query: any = {};

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = startDate;
        if (endDate) query.createdAt.$lte = endDate;
      }

      if (productId) {
        query.productId = productId;
      }

      const transfers = await CustodialTransfer.find(query)
        .populate('tradeId', 'totalAmount')
        .lean();

      const totalTransfers = transfers.length;
      const pendingTransfers = transfers.filter(t => 
        ['pending', 'submitted', 'confirmed'].includes(t.status)
      ).length;
      const completedTransfers = transfers.filter(t => t.status === 'settled').length;
      const failedTransfers = transfers.filter(t => t.status === 'failed').length;

      const totalValue = transfers.reduce((sum, transfer) => {
        const trade = transfer.tradeId as any;
        return sum + (trade?.totalAmount || 0);
      }, 0);

      // Calculate average settlement time for completed transfers
      const settledTransfers = transfers.filter(t => t.status === 'settled' && t.settledAt);
      const averageSettlementTime = settledTransfers.length > 0
        ? settledTransfers.reduce((sum, transfer) => {
            const settlementTime = transfer.settledAt!.getTime() - transfer.createdAt.getTime();
            return sum + settlementTime;
          }, 0) / settledTransfers.length / (1000 * 60 * 60) // Convert to hours
        : 0;

      return {
        totalTransfers,
        pendingTransfers,
        completedTransfers,
        failedTransfers,
        totalValue,
        averageSettlementTime,
      };

    } catch (error) {
      logger.error('Failed to get asset transfer summary:', error);
      throw error;
    }
  }

  /**
   * Get detailed transfer audit trail
   */
  async getTransferAuditTrail(
    transferId: string
  ): Promise<{
    transfer: ICustodialTransfer;
    trade: ITrade;
    shareRegisterChanges: IShareRegisterEntry[];
    workflow: AssetTransferWorkflow;
  }> {
    try {
      const transfer = await CustodialTransfer.findOne({ transferId })
        .populate('fromUserId', 'email')
        .populate('toUserId', 'email')
        .populate('productId', 'name symbol')
        .populate('tradeId');

      if (!transfer) {
        throw new Error('Transfer not found');
      }

      const trade = await Trade.findById(transfer.tradeId);
      if (!trade) {
        throw new Error('Associated trade not found');
      }

      // Get share register changes
      const shareRegisterChanges = await ShareRegister.find({
        $or: [
          { userId: transfer.fromUserId, productId: transfer.productId },
          { userId: transfer.toUserId, productId: transfer.productId },
        ],
        'transferHistory.custodialTransferId': transfer._id,
      });

      // Reconstruct workflow status
      const workflow: AssetTransferWorkflow = {
        tradeId: transfer.tradeId,
        buyerId: transfer.toUserId,
        sellerId: transfer.fromUserId,
        productId: transfer.productId,
        quantity: transfer.quantity,
        pricePerShare: trade.pricePerShare,
        status: this.mapTransferStatusToWorkflowStatus(transfer.status),
        steps: this.reconstructWorkflowSteps(transfer),
        createdAt: transfer.createdAt,
        completedAt: transfer.settledAt,
      };

      return {
        transfer,
        trade,
        shareRegisterChanges,
        workflow,
      };

    } catch (error) {
      logger.error('Failed to get transfer audit trail:', error);
      throw error;
    }
  }

  /**
   * Reconcile all holdings for a user
   */
  async reconcileUserHoldings(userId: mongoose.Types.ObjectId): Promise<OwnershipVerification[]> {
    try {
      const portfolio = await Portfolio.findOne({ userId });
      if (!portfolio) {
        return [];
      }

      const verifications: OwnershipVerification[] = [];

      for (const holding of portfolio.holdings) {
        const verification = await this.verifyOwnership(userId, holding.productId);
        verifications.push(verification);
      }

      return verifications;

    } catch (error) {
      logger.error('Failed to reconcile user holdings:', error);
      throw error;
    }
  }

  /**
   * Private helper methods
   */

  private async executeWorkflowStep(
    workflow: AssetTransferWorkflow,
    stepName: string,
    stepFunction: () => Promise<void>
  ): Promise<void> {
    const step = workflow.steps.find(s => s.step === stepName);
    if (!step) {
      throw new Error(`Workflow step not found: ${stepName}`);
    }

    try {
      await stepFunction();
      step.status = 'completed';
      step.completedAt = new Date();
      
      logger.info(`Workflow step completed: ${stepName}`, {
        tradeId: workflow.tradeId,
        step: stepName,
      });

    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Unknown error';
      
      logger.error(`Workflow step failed: ${stepName}`, {
        tradeId: workflow.tradeId,
        step: stepName,
        error: step.error,
      });

      throw error;
    }
  }

  private mapTransferStatusToWorkflowStatus(
    transferStatus: string
  ): AssetTransferWorkflow['status'] {
    switch (transferStatus) {
      case 'pending':
        return 'initiated';
      case 'submitted':
        return 'custodian_submitted';
      case 'confirmed':
        return 'custodian_confirmed';
      case 'settled':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'initiated';
    }
  }

  private reconstructWorkflowSteps(transfer: ICustodialTransfer): AssetTransferWorkflow['steps'] {
    const steps: AssetTransferWorkflow['steps'] = [
      { step: 'validate_ownership', status: 'completed' },
      { step: 'initiate_custodial_transfer', status: 'completed' },
    ];

    if (transfer.submittedAt) {
      steps.push({
        step: 'submit_to_custodian',
        status: 'completed',
        completedAt: transfer.submittedAt,
      });
    }

    if (transfer.confirmedAt) {
      steps.push({
        step: 'confirm_custodial_transfer',
        status: 'completed',
        completedAt: transfer.confirmedAt,
      });
    }

    if (transfer.settledAt) {
      steps.push(
        {
          step: 'update_share_register',
          status: 'completed',
          completedAt: transfer.settledAt,
        },
        {
          step: 'update_portfolios',
          status: 'completed',
          completedAt: transfer.settledAt,
        },
        {
          step: 'finalize_ownership',
          status: 'completed',
          completedAt: transfer.settledAt,
        }
      );
    }

    return steps;
  }
}

// Export singleton instance
export const assetTransferService = new AssetTransferService(custodianService);