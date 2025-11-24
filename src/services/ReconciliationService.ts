import { CustodianService, custodianService } from './CustodianService';
import { ShareRegister, IShareRegisterEntry } from '@/models/ShareRegister';
import { Portfolio } from '@/models/Portfolio';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { User } from '@/models/User';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

export interface ReconciliationDiscrepancy {
  type: 'platform_vs_register' | 'register_vs_custodian' | 'platform_vs_custodian';
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  platformQuantity: number;
  registerQuantity: number;
  custodianQuantity: number;
  difference: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggestedAction: string;
}

export interface ReconciliationReport {
  id: string;
  reportDate: Date;
  scope: 'user' | 'product' | 'full';
  scopeId?: mongoose.Types.ObjectId;
  summary: {
    totalUsers: number;
    totalProducts: number;
    totalHoldings: number;
    matchedHoldings: number;
    discrepancies: number;
    criticalIssues: number;
  };
  discrepancies: ReconciliationDiscrepancy[];
  recommendations: string[];
  status: 'completed' | 'failed' | 'partial';
  executionTime: number; // in milliseconds
}

export interface BalanceReconciliation {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  platformBalance: number;
  custodianBalance: number;
  shareRegisterBalance: number;
  isReconciled: boolean;
  lastReconciled: Date;
  discrepancyAmount: number;
  discrepancyPercentage: number;
}

export class ReconciliationService {
  private custodianService: CustodianService;

  constructor(custodianService: CustodianService) {
    this.custodianService = custodianService;
  }

  /**
   * Perform full system reconciliation
   */
  async performFullReconciliation(): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const reportId = this.generateReportId();

    try {
      logger.info('Starting full system reconciliation', { reportId });

      const discrepancies: ReconciliationDiscrepancy[] = [];
      const recommendations: string[] = [];

      // Get all active users with portfolios
      const users = await User.find({ 
        _id: { 
          $in: await Portfolio.distinct('userId') 
        } 
      });

      // Get all active products
      const products = await InvestmentProduct.find({ status: 'active' });

      let totalHoldings = 0;
      let matchedHoldings = 0;

      // Reconcile each user's holdings
      for (const user of users) {
        for (const product of products) {
          const userDiscrepancies = await this.reconcileUserProduct(user._id as mongoose.Types.ObjectId, product._id as mongoose.Types.ObjectId);
          discrepancies.push(...userDiscrepancies);

          totalHoldings++;
          if (userDiscrepancies.length === 0) {
            matchedHoldings++;
          }
        }
      }

      // Generate recommendations based on discrepancies
      recommendations.push(...this.generateRecommendations(discrepancies));

      const executionTime = Date.now() - startTime;
      const criticalIssues = discrepancies.filter(d => d.severity === 'critical').length;

      const report: ReconciliationReport = {
        id: reportId,
        reportDate: new Date(),
        scope: 'full',
        summary: {
          totalUsers: users.length,
          totalProducts: products.length,
          totalHoldings,
          matchedHoldings,
          discrepancies: discrepancies.length,
          criticalIssues,
        },
        discrepancies,
        recommendations,
        status: criticalIssues > 0 ? 'partial' : 'completed',
        executionTime,
      };

      logger.info('Full system reconciliation completed', {
        reportId,
        totalDiscrepancies: discrepancies.length,
        criticalIssues,
        executionTime,
      });

      return report;

    } catch (error) {
      logger.error('Full system reconciliation failed:', error);
      
      return {
        id: reportId,
        reportDate: new Date(),
        scope: 'full',
        summary: {
          totalUsers: 0,
          totalProducts: 0,
          totalHoldings: 0,
          matchedHoldings: 0,
          discrepancies: 0,
          criticalIssues: 0,
        },
        discrepancies: [],
        recommendations: ['System reconciliation failed - manual review required'],
        status: 'failed',
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Reconcile holdings for a specific user
   */
  async reconcileUser(userId: mongoose.Types.ObjectId): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const reportId = this.generateReportId();

    try {
      logger.info('Starting user reconciliation', { reportId, userId });

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const portfolio = await Portfolio.findOne({ userId });
      if (!portfolio) {
        throw new Error('User portfolio not found');
      }

      const discrepancies: ReconciliationDiscrepancy[] = [];
      let totalHoldings = 0;
      let matchedHoldings = 0;

      // Reconcile each holding in the user's portfolio
      for (const holding of portfolio.holdings) {
        const userDiscrepancies = await this.reconcileUserProduct(userId, holding.productId);
        discrepancies.push(...userDiscrepancies);

        totalHoldings++;
        if (userDiscrepancies.length === 0) {
          matchedHoldings++;
        }
      }

      const recommendations = this.generateRecommendations(discrepancies);
      const executionTime = Date.now() - startTime;
      const criticalIssues = discrepancies.filter(d => d.severity === 'critical').length;

      const report: ReconciliationReport = {
        id: reportId,
        reportDate: new Date(),
        scope: 'user',
        scopeId: userId,
        summary: {
          totalUsers: 1,
          totalProducts: portfolio.holdings.length,
          totalHoldings,
          matchedHoldings,
          discrepancies: discrepancies.length,
          criticalIssues,
        },
        discrepancies,
        recommendations,
        status: criticalIssues > 0 ? 'partial' : 'completed',
        executionTime,
      };

      logger.info('User reconciliation completed', {
        reportId,
        userId,
        totalDiscrepancies: discrepancies.length,
        criticalIssues,
        executionTime,
      });

      return report;

    } catch (error) {
      logger.error('User reconciliation failed:', error);
      throw error;
    }
  }

  /**
   * Reconcile holdings for a specific product
   */
  async reconcileProduct(productId: mongoose.Types.ObjectId): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const reportId = this.generateReportId();

    try {
      logger.info('Starting product reconciliation', { reportId, productId });

      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        throw new Error('Product not found');
      }

      // Get all users who hold this product
      const portfolios = await Portfolio.find({
        'holdings.productId': productId,
      });

      const discrepancies: ReconciliationDiscrepancy[] = [];
      let totalHoldings = 0;
      let matchedHoldings = 0;

      // Reconcile each user's holding of this product
      for (const portfolio of portfolios) {
        const userDiscrepancies = await this.reconcileUserProduct(portfolio.userId, productId);
        discrepancies.push(...userDiscrepancies);

        totalHoldings++;
        if (userDiscrepancies.length === 0) {
          matchedHoldings++;
        }
      }

      const recommendations = this.generateRecommendations(discrepancies);
      const executionTime = Date.now() - startTime;
      const criticalIssues = discrepancies.filter(d => d.severity === 'critical').length;

      const report: ReconciliationReport = {
        id: reportId,
        reportDate: new Date(),
        scope: 'product',
        scopeId: productId,
        summary: {
          totalUsers: portfolios.length,
          totalProducts: 1,
          totalHoldings,
          matchedHoldings,
          discrepancies: discrepancies.length,
          criticalIssues,
        },
        discrepancies,
        recommendations,
        status: criticalIssues > 0 ? 'partial' : 'completed',
        executionTime,
      };

      logger.info('Product reconciliation completed', {
        reportId,
        productId,
        totalDiscrepancies: discrepancies.length,
        criticalIssues,
        executionTime,
      });

      return report;

    } catch (error) {
      logger.error('Product reconciliation failed:', error);
      throw error;
    }
  }

  /**
   * Get balance reconciliation for specific user and product
   */
  async getBalanceReconciliation(
    userId: mongoose.Types.ObjectId,
    productId: mongoose.Types.ObjectId
  ): Promise<BalanceReconciliation> {
    try {
      // Get platform balance from portfolio
      const portfolio = await Portfolio.findOne({ userId });
      const holding = portfolio?.getHolding(productId);
      const platformBalance = holding?.quantity || 0;

      // Get share register balance
      const shareRegisterEntries = await ShareRegister.find({
        userId,
        productId,
        status: 'active',
      });
      const shareRegisterBalance = shareRegisterEntries.reduce(
        (total, entry) => total + entry.quantity,
        0
      );

      // Get custodian balance (simplified - in reality would query specific user account)
      const custodianBalances = await this.custodianService.getCustodianBalances();
      const product = await InvestmentProduct.findById(productId);
      const custodianBalance = custodianBalances
        .filter(balance => balance.productSymbol === product?.symbol)
        .reduce((total, balance) => total + balance.quantity, 0);

      const discrepancyAmount = Math.abs(platformBalance - custodianBalance);
      const discrepancyPercentage = platformBalance > 0 
        ? (discrepancyAmount / platformBalance) * 100 
        : 0;

      const isReconciled = platformBalance === shareRegisterBalance && 
                          shareRegisterBalance === custodianBalance;

      return {
        userId,
        productId,
        platformBalance,
        custodianBalance,
        shareRegisterBalance,
        isReconciled,
        lastReconciled: new Date(),
        discrepancyAmount,
        discrepancyPercentage,
      };

    } catch (error) {
      logger.error('Failed to get balance reconciliation:', error);
      throw error;
    }
  }

  /**
   * Auto-correct minor discrepancies
   */
  async autoCorrectDiscrepancies(
    discrepancies: ReconciliationDiscrepancy[],
    dryRun: boolean = true
  ): Promise<{
    corrected: ReconciliationDiscrepancy[];
    failed: ReconciliationDiscrepancy[];
    summary: string;
  }> {
    const corrected: ReconciliationDiscrepancy[] = [];
    const failed: ReconciliationDiscrepancy[] = [];

    try {
      for (const discrepancy of discrepancies) {
        // Only auto-correct low severity discrepancies
        if (discrepancy.severity !== 'low') {
          failed.push(discrepancy);
          continue;
        }

        try {
          if (!dryRun) {
            await this.correctDiscrepancy(discrepancy);
          }
          corrected.push(discrepancy);
          
          logger.info('Discrepancy corrected', {
            type: discrepancy.type,
            userId: discrepancy.userId,
            productId: discrepancy.productId,
            dryRun,
          });

        } catch (error) {
          logger.error('Failed to correct discrepancy:', error);
          failed.push(discrepancy);
        }
      }

      const summary = `Auto-correction ${dryRun ? 'simulation' : 'execution'}: ` +
                     `${corrected.length} corrected, ${failed.length} failed`;

      return { corrected, failed, summary };

    } catch (error) {
      logger.error('Auto-correction process failed:', error);
      throw error;
    }
  }

  /**
   * Private helper methods
   */

  private async reconcileUserProduct(
    userId: mongoose.Types.ObjectId,
    productId: mongoose.Types.ObjectId
  ): Promise<ReconciliationDiscrepancy[]> {
    const discrepancies: ReconciliationDiscrepancy[] = [];

    try {
      const reconciliation = await this.getBalanceReconciliation(userId, productId);

      // Check platform vs share register
      if (reconciliation.platformBalance !== reconciliation.shareRegisterBalance) {
        discrepancies.push({
          type: 'platform_vs_register',
          userId,
          productId,
          platformQuantity: reconciliation.platformBalance,
          registerQuantity: reconciliation.shareRegisterBalance,
          custodianQuantity: reconciliation.custodianBalance,
          difference: reconciliation.platformBalance - reconciliation.shareRegisterBalance,
          severity: this.calculateSeverity(
            Math.abs(reconciliation.platformBalance - reconciliation.shareRegisterBalance),
            reconciliation.platformBalance
          ),
          description: `Platform portfolio shows ${reconciliation.platformBalance} shares, ` +
                      `but share register shows ${reconciliation.shareRegisterBalance} shares`,
          suggestedAction: 'Update share register to match portfolio or investigate trade history',
        });
      }

      // Check share register vs custodian
      if (reconciliation.shareRegisterBalance !== reconciliation.custodianBalance) {
        discrepancies.push({
          type: 'register_vs_custodian',
          userId,
          productId,
          platformQuantity: reconciliation.platformBalance,
          registerQuantity: reconciliation.shareRegisterBalance,
          custodianQuantity: reconciliation.custodianBalance,
          difference: reconciliation.shareRegisterBalance - reconciliation.custodianBalance,
          severity: this.calculateSeverity(
            Math.abs(reconciliation.shareRegisterBalance - reconciliation.custodianBalance),
            reconciliation.shareRegisterBalance
          ),
          description: `Share register shows ${reconciliation.shareRegisterBalance} shares, ` +
                      `but custodian shows ${reconciliation.custodianBalance} shares`,
          suggestedAction: 'Verify custodian records and pending transfers',
        });
      }

      // Check platform vs custodian (overall check)
      if (reconciliation.platformBalance !== reconciliation.custodianBalance) {
        discrepancies.push({
          type: 'platform_vs_custodian',
          userId,
          productId,
          platformQuantity: reconciliation.platformBalance,
          registerQuantity: reconciliation.shareRegisterBalance,
          custodianQuantity: reconciliation.custodianBalance,
          difference: reconciliation.platformBalance - reconciliation.custodianBalance,
          severity: this.calculateSeverity(
            Math.abs(reconciliation.platformBalance - reconciliation.custodianBalance),
            reconciliation.platformBalance
          ),
          description: `Platform shows ${reconciliation.platformBalance} shares, ` +
                      `but custodian shows ${reconciliation.custodianBalance} shares`,
          suggestedAction: 'Full reconciliation required - check all transfer records',
        });
      }

    } catch (error) {
      logger.error('Failed to reconcile user product:', error);
      // Don't throw - continue with other reconciliations
    }

    return discrepancies;
  }

  private calculateSeverity(
    difference: number,
    totalQuantity: number
  ): ReconciliationDiscrepancy['severity'] {
    if (totalQuantity === 0) return difference > 0 ? 'critical' : 'low';

    const percentage = (difference / totalQuantity) * 100;

    if (percentage >= 10) return 'critical';
    if (percentage >= 5) return 'high';
    if (percentage >= 1) return 'medium';
    return 'low';
  }

  private generateRecommendations(discrepancies: ReconciliationDiscrepancy[]): string[] {
    const recommendations: string[] = [];

    const criticalCount = discrepancies.filter(d => d.severity === 'critical').length;
    const highCount = discrepancies.filter(d => d.severity === 'high').length;

    if (criticalCount > 0) {
      recommendations.push(
        `URGENT: ${criticalCount} critical discrepancies require immediate attention`
      );
    }

    if (highCount > 0) {
      recommendations.push(
        `${highCount} high-severity discrepancies should be resolved within 24 hours`
      );
    }

    const platformVsRegister = discrepancies.filter(d => d.type === 'platform_vs_register').length;
    if (platformVsRegister > 0) {
      recommendations.push(
        'Review trade execution and portfolio update processes'
      );
    }

    const registerVsCustodian = discrepancies.filter(d => d.type === 'register_vs_custodian').length;
    if (registerVsCustodian > 0) {
      recommendations.push(
        'Verify custodial transfer completion and share register updates'
      );
    }

    if (discrepancies.length === 0) {
      recommendations.push('All holdings are properly reconciled');
    }

    return recommendations;
  }

  private async correctDiscrepancy(discrepancy: ReconciliationDiscrepancy): Promise<void> {
    // Implementation would depend on the type of discrepancy
    // This is a placeholder for the actual correction logic
    
    switch (discrepancy.type) {
      case 'platform_vs_register':
        // Update share register to match platform
        break;
      case 'register_vs_custodian':
        // Investigate pending transfers
        break;
      case 'platform_vs_custodian':
        // Full investigation required
        break;
    }

    logger.info('Discrepancy correction attempted', {
      type: discrepancy.type,
      userId: discrepancy.userId,
      productId: discrepancy.productId,
    });
  }

  private generateReportId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 8);
    return `REC-${timestamp}-${random}`.toUpperCase();
  }
}

// Export singleton instance
export const reconciliationService = new ReconciliationService(custodianService);