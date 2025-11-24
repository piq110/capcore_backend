import { FeeTransaction } from '@/models/FeeTransaction';
import { ListingFee } from '@/models/ListingFee';
import { Trade } from '@/models/Trade';
import { Withdrawal } from '@/models/Withdrawal';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

export interface RevenueBreakdown {
  tradingFees: {
    buyerFees: number;
    sellerFees: number;
    total: number;
    transactionCount: number;
  };
  withdrawalFees: {
    total: number;
    transactionCount: number;
  };
  depositFees: {
    total: number;
    transactionCount: number;
  };
  listingFees: {
    initialListings: number;
    annualMaintenance: number;
    total: number;
    transactionCount: number;
  };
  totalRevenue: number;
  period: {
    startDate: Date;
    endDate: Date;
  };
}

export interface RevenueAnalytics {
  currentPeriod: RevenueBreakdown;
  previousPeriod: RevenueBreakdown;
  growth: {
    totalRevenue: number; // percentage
    tradingFees: number;
    withdrawalFees: number;
    listingFees: number;
  };
  trends: {
    daily: Array<{
      date: string;
      revenue: number;
      tradingFees: number;
      withdrawalFees: number;
      listingFees: number;
    }>;
    monthly: Array<{
      month: string;
      revenue: number;
      tradingFees: number;
      withdrawalFees: number;
      listingFees: number;
    }>;
  };
  topRevenueSources: Array<{
    source: string;
    amount: number;
    percentage: number;
  }>;
}

export interface UserFeeReport {
  userId: mongoose.Types.ObjectId;
  period: {
    startDate: Date;
    endDate: Date;
  };
  fees: {
    trading: {
      buyerFees: number;
      sellerFees: number;
      total: number;
      transactionCount: number;
    };
    withdrawal: {
      total: number;
      transactionCount: number;
    };
    deposit: {
      total: number;
      transactionCount: number;
    };
  };
  totalFeesPaid: number;
  transactions: Array<{
    id: mongoose.Types.ObjectId;
    type: string;
    category: string;
    amount: number;
    date: Date;
    status: string;
  }>;
}

export interface IssuerBillingReport {
  issuerId: mongoose.Types.ObjectId;
  period: {
    startDate: Date;
    endDate: Date;
  };
  listingFees: {
    initialListings: Array<{
      productId: mongoose.Types.ObjectId;
      productName: string;
      amount: number;
      dueDate: Date;
      status: string;
      paidDate?: Date;
    }>;
    annualMaintenance: Array<{
      productId: mongoose.Types.ObjectId;
      productName: string;
      amount: number;
      dueDate: Date;
      status: string;
      paidDate?: Date;
    }>;
  };
  totalDue: number;
  totalPaid: number;
  totalOverdue: number;
  paymentHistory: Array<{
    feeId: mongoose.Types.ObjectId;
    amount: number;
    paidDate: Date;
    paymentMethod: string;
  }>;
}

export class RevenueService {
  /**
   * Get comprehensive revenue breakdown for a period
   */
  async getRevenueBreakdown(startDate: Date, endDate: Date): Promise<RevenueBreakdown> {
    try {
      const dateFilter = {
        createdAt: { $gte: startDate, $lte: endDate },
        status: 'collected'
      };

      // Get trading fees breakdown
      const tradingFeesData = await FeeTransaction.aggregate([
        {
          $match: {
            ...dateFilter,
            feeType: 'trading'
          }
        },
        {
          $group: {
            _id: '$feeCategory',
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      const buyerFees = tradingFeesData.find(item => item._id === 'buyer_fee')?.total || 0;
      const sellerFees = tradingFeesData.find(item => item._id === 'seller_fee')?.total || 0;
      const tradingTransactionCount = tradingFeesData.reduce((sum, item) => sum + item.count, 0);

      // Get withdrawal fees
      const withdrawalFeesData = await FeeTransaction.aggregate([
        {
          $match: {
            ...dateFilter,
            feeType: 'withdrawal'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      const withdrawalFees = withdrawalFeesData[0]?.total || 0;
      const withdrawalTransactionCount = withdrawalFeesData[0]?.count || 0;

      // Get deposit fees
      const depositFeesData = await FeeTransaction.aggregate([
        {
          $match: {
            ...dateFilter,
            feeType: 'deposit'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      const depositFees = depositFeesData[0]?.total || 0;
      const depositTransactionCount = depositFeesData[0]?.count || 0;

      // Get listing fees
      const listingFeesData = await ListingFee.aggregate([
        {
          $match: {
            paidDate: { $gte: startDate, $lte: endDate },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: '$feeType',
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      const initialListingFees = listingFeesData.find(item => item._id === 'initial_listing')?.total || 0;
      const annualMaintenanceFees = listingFeesData.find(item => item._id === 'annual_maintenance')?.total || 0;
      const listingTransactionCount = listingFeesData.reduce((sum, item) => sum + item.count, 0);

      const totalRevenue = buyerFees + sellerFees + withdrawalFees + depositFees + initialListingFees + annualMaintenanceFees;

      return {
        tradingFees: {
          buyerFees,
          sellerFees,
          total: buyerFees + sellerFees,
          transactionCount: tradingTransactionCount
        },
        withdrawalFees: {
          total: withdrawalFees,
          transactionCount: withdrawalTransactionCount
        },
        depositFees: {
          total: depositFees,
          transactionCount: depositTransactionCount
        },
        listingFees: {
          initialListings: initialListingFees,
          annualMaintenance: annualMaintenanceFees,
          total: initialListingFees + annualMaintenanceFees,
          transactionCount: listingTransactionCount
        },
        totalRevenue,
        period: {
          startDate,
          endDate
        }
      };
    } catch (error) {
      logger.error('Failed to get revenue breakdown:', error);
      throw error;
    }
  }

  /**
   * Get comprehensive revenue analytics with trends and growth
   */
  async getRevenueAnalytics(startDate: Date, endDate: Date): Promise<RevenueAnalytics> {
    try {
      // Calculate period duration for previous period comparison
      const periodDuration = endDate.getTime() - startDate.getTime();
      const previousStartDate = new Date(startDate.getTime() - periodDuration);
      const previousEndDate = new Date(startDate.getTime() - 1);

      // Get current and previous period breakdowns
      const [currentPeriod, previousPeriod] = await Promise.all([
        this.getRevenueBreakdown(startDate, endDate),
        this.getRevenueBreakdown(previousStartDate, previousEndDate)
      ]);

      // Calculate growth percentages
      const growth = {
        totalRevenue: this.calculateGrowthPercentage(previousPeriod.totalRevenue, currentPeriod.totalRevenue),
        tradingFees: this.calculateGrowthPercentage(previousPeriod.tradingFees.total, currentPeriod.tradingFees.total),
        withdrawalFees: this.calculateGrowthPercentage(previousPeriod.withdrawalFees.total, currentPeriod.withdrawalFees.total),
        listingFees: this.calculateGrowthPercentage(previousPeriod.listingFees.total, currentPeriod.listingFees.total)
      };

      // Get daily trends
      const dailyTrends = await this.getDailyRevenueTrends(startDate, endDate);

      // Get monthly trends (last 12 months)
      const monthlyStartDate = new Date();
      monthlyStartDate.setMonth(monthlyStartDate.getMonth() - 12);
      const monthlyTrends = await this.getMonthlyRevenueTrends(monthlyStartDate, endDate);

      // Calculate top revenue sources
      const topRevenueSources = [
        { source: 'Trading Fees', amount: currentPeriod.tradingFees.total, percentage: 0 },
        { source: 'Withdrawal Fees', amount: currentPeriod.withdrawalFees.total, percentage: 0 },
        { source: 'Listing Fees', amount: currentPeriod.listingFees.total, percentage: 0 },
        { source: 'Deposit Fees', amount: currentPeriod.depositFees.total, percentage: 0 }
      ].map(source => ({
        ...source,
        percentage: currentPeriod.totalRevenue > 0 ? (source.amount / currentPeriod.totalRevenue) * 100 : 0
      })).sort((a, b) => b.amount - a.amount);

      return {
        currentPeriod,
        previousPeriod,
        growth,
        trends: {
          daily: dailyTrends,
          monthly: monthlyTrends
        },
        topRevenueSources
      };
    } catch (error) {
      logger.error('Failed to get revenue analytics:', error);
      throw error;
    }
  }

  /**
   * Get fee transparency report for a user
   */
  async getUserFeeReport(userId: mongoose.Types.ObjectId, startDate: Date, endDate: Date): Promise<UserFeeReport> {
    try {
      const dateFilter = {
        userId,
        createdAt: { $gte: startDate, $lte: endDate },
        status: 'collected'
      };

      // Get all fee transactions for the user
      const feeTransactions = await FeeTransaction.find(dateFilter)
        .sort({ createdAt: -1 })
        .lean();

      // Group by fee type and category
      const tradingBuyerFees = feeTransactions.filter(t => t.feeCategory === 'buyer_fee');
      const tradingSellerFees = feeTransactions.filter(t => t.feeCategory === 'seller_fee');
      const withdrawalFees = feeTransactions.filter(t => t.feeType === 'withdrawal');
      const depositFees = feeTransactions.filter(t => t.feeType === 'deposit');

      const totalFeesPaid = feeTransactions.reduce((sum, fee) => sum + fee.amount, 0);

      return {
        userId,
        period: { startDate, endDate },
        fees: {
          trading: {
            buyerFees: tradingBuyerFees.reduce((sum, fee) => sum + fee.amount, 0),
            sellerFees: tradingSellerFees.reduce((sum, fee) => sum + fee.amount, 0),
            total: tradingBuyerFees.reduce((sum, fee) => sum + fee.amount, 0) + tradingSellerFees.reduce((sum, fee) => sum + fee.amount, 0),
            transactionCount: tradingBuyerFees.length + tradingSellerFees.length
          },
          withdrawal: {
            total: withdrawalFees.reduce((sum, fee) => sum + fee.amount, 0),
            transactionCount: withdrawalFees.length
          },
          deposit: {
            total: depositFees.reduce((sum, fee) => sum + fee.amount, 0),
            transactionCount: depositFees.length
          }
        },
        totalFeesPaid,
        transactions: feeTransactions.map(fee => ({
          id: fee._id as mongoose.Types.ObjectId,
          type: fee.feeType,
          category: fee.feeCategory,
          amount: fee.amount,
          date: fee.createdAt,
          status: fee.status
        }))
      };
    } catch (error) {
      logger.error('Failed to get user fee report:', error);
      throw error;
    }
  }

  /**
   * Get issuer billing and payment tracking report
   */
  async getIssuerBillingReport(issuerId: mongoose.Types.ObjectId, startDate: Date, endDate: Date): Promise<IssuerBillingReport> {
    try {
      // Get all listing fees for the issuer in the period
      const listingFees = await ListingFee.find({
        issuerId,
        $or: [
          { dueDate: { $gte: startDate, $lte: endDate } },
          { paidDate: { $gte: startDate, $lte: endDate } }
        ]
      })
      .populate('productId', 'name symbol')
      .sort({ dueDate: -1 })
      .lean();

      // Separate by fee type
      const initialListings = listingFees
        .filter(fee => fee.feeType === 'initial_listing')
        .map(fee => ({
          productId: fee.productId._id,
          productName: (fee.productId as any).name,
          amount: fee.amount,
          dueDate: fee.dueDate,
          status: fee.status,
          paidDate: fee.paidDate
        }));

      const annualMaintenance = listingFees
        .filter(fee => fee.feeType === 'annual_maintenance')
        .map(fee => ({
          productId: fee.productId._id,
          productName: (fee.productId as any).name,
          amount: fee.amount,
          dueDate: fee.dueDate,
          status: fee.status,
          paidDate: fee.paidDate
        }));

      // Calculate totals
      const totalDue = listingFees
        .filter(fee => ['pending', 'overdue'].includes(fee.status))
        .reduce((sum, fee) => sum + fee.amount, 0);

      const totalPaid = listingFees
        .filter(fee => fee.status === 'paid')
        .reduce((sum, fee) => sum + fee.amount, 0);

      const totalOverdue = listingFees
        .filter(fee => fee.status === 'overdue')
        .reduce((sum, fee) => sum + fee.amount, 0);

      // Get payment history
      const paymentHistory = listingFees
        .filter(fee => fee.status === 'paid' && fee.paidDate)
        .map(fee => ({
          feeId: fee._id as mongoose.Types.ObjectId,
          amount: fee.amount,
          paidDate: fee.paidDate!,
          paymentMethod: fee.paymentMethod || 'unknown'
        }))
        .sort((a, b) => b.paidDate.getTime() - a.paidDate.getTime());

      return {
        issuerId,
        period: { startDate, endDate },
        listingFees: {
          initialListings,
          annualMaintenance
        },
        totalDue,
        totalPaid,
        totalOverdue,
        paymentHistory
      };
    } catch (error) {
      logger.error('Failed to get issuer billing report:', error);
      throw error;
    }
  }

  /**
   * Get daily revenue trends
   */
  private async getDailyRevenueTrends(startDate: Date, endDate: Date): Promise<Array<{
    date: string;
    revenue: number;
    tradingFees: number;
    withdrawalFees: number;
    listingFees: number;
  }>> {
    try {
      // Get daily fee transactions
      const dailyFees = await FeeTransaction.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            status: 'collected'
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              feeType: '$feeType'
            },
            total: { $sum: '$amount' }
          }
        },
        {
          $group: {
            _id: '$_id.date',
            fees: {
              $push: {
                type: '$_id.feeType',
                amount: '$total'
              }
            }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);

      // Get daily listing fees
      const dailyListingFees = await ListingFee.aggregate([
        {
          $match: {
            paidDate: { $gte: startDate, $lte: endDate },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidDate' } },
            total: { $sum: '$amount' }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);

      // Combine and format results
      const dailyData = new Map();

      // Process fee transactions
      dailyFees.forEach(day => {
        const date = day._id;
        if (!dailyData.has(date)) {
          dailyData.set(date, { date, revenue: 0, tradingFees: 0, withdrawalFees: 0, listingFees: 0 });
        }

        const dayData = dailyData.get(date);
        day.fees.forEach((fee: any) => {
          if (fee.type === 'trading') {
            dayData.tradingFees += fee.amount;
          } else if (fee.type === 'withdrawal') {
            dayData.withdrawalFees += fee.amount;
          }
          dayData.revenue += fee.amount;
        });
      });

      // Process listing fees
      dailyListingFees.forEach(day => {
        const date = day._id;
        if (!dailyData.has(date)) {
          dailyData.set(date, { date, revenue: 0, tradingFees: 0, withdrawalFees: 0, listingFees: 0 });
        }

        const dayData = dailyData.get(date);
        dayData.listingFees += day.total;
        dayData.revenue += day.total;
      });

      return Array.from(dailyData.values()).sort((a, b) => a.date.localeCompare(b.date));
    } catch (error) {
      logger.error('Failed to get daily revenue trends:', error);
      throw error;
    }
  }

  /**
   * Get monthly revenue trends
   */
  private async getMonthlyRevenueTrends(startDate: Date, endDate: Date): Promise<Array<{
    month: string;
    revenue: number;
    tradingFees: number;
    withdrawalFees: number;
    listingFees: number;
  }>> {
    try {
      // Similar to daily trends but grouped by month
      const monthlyFees = await FeeTransaction.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            status: 'collected'
          }
        },
        {
          $group: {
            _id: {
              month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
              feeType: '$feeType'
            },
            total: { $sum: '$amount' }
          }
        },
        {
          $group: {
            _id: '$_id.month',
            fees: {
              $push: {
                type: '$_id.feeType',
                amount: '$total'
              }
            }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);

      const monthlyListingFees = await ListingFee.aggregate([
        {
          $match: {
            paidDate: { $gte: startDate, $lte: endDate },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$paidDate' } },
            total: { $sum: '$amount' }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);

      // Combine and format results (similar to daily trends)
      const monthlyData = new Map();

      monthlyFees.forEach(month => {
        const monthKey = month._id;
        if (!monthlyData.has(monthKey)) {
          monthlyData.set(monthKey, { month: monthKey, revenue: 0, tradingFees: 0, withdrawalFees: 0, listingFees: 0 });
        }

        const monthData = monthlyData.get(monthKey);
        month.fees.forEach((fee: any) => {
          if (fee.type === 'trading') {
            monthData.tradingFees += fee.amount;
          } else if (fee.type === 'withdrawal') {
            monthData.withdrawalFees += fee.amount;
          }
          monthData.revenue += fee.amount;
        });
      });

      monthlyListingFees.forEach(month => {
        const monthKey = month._id;
        if (!monthlyData.has(monthKey)) {
          monthlyData.set(monthKey, { month: monthKey, revenue: 0, tradingFees: 0, withdrawalFees: 0, listingFees: 0 });
        }

        const monthData = monthlyData.get(monthKey);
        monthData.listingFees += month.total;
        monthData.revenue += month.total;
      });

      return Array.from(monthlyData.values()).sort((a, b) => a.month.localeCompare(b.month));
    } catch (error) {
      logger.error('Failed to get monthly revenue trends:', error);
      throw error;
    }
  }

  /**
   * Calculate growth percentage between two values
   */
  private calculateGrowthPercentage(previousValue: number, currentValue: number): number {
    if (previousValue === 0) {
      return currentValue > 0 ? 100 : 0;
    }
    return ((currentValue - previousValue) / previousValue) * 100;
  }
}

export const revenueService = new RevenueService();