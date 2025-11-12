import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { KYCSubmission, IKYCSubmission, IKYCDocument } from '@/models/KYC';
import { User } from '@/models/User';
import { logger, securityLogger } from '@/utils/logger';
import { cloudinaryService } from '@/services/CloudinaryService';
import config from '@/config';
import mongoose from 'mongoose';

export interface KYCSubmissionData {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  nationality: string;
  phoneNumber: string;
  address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  accreditedInvestor?: {
    claimed: boolean;
    type?: 'income' | 'net_worth' | 'professional' | 'entity';
    annualIncome?: number;
    netWorth?: number;
    professionalCertification?: string;
    entityType?: string;
  };
}

export interface FileUpload {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

class KYCService {
  private readonly encryptionKey: string;
  private readonly uploadDir: string;

  constructor() {
    this.encryptionKey = config.encryption?.kycKey || crypto.randomBytes(32).toString('hex');
    this.uploadDir = path.join(process.cwd(), 'uploads', 'kyc');
    this.ensureUploadDirectory();
  }

  private async ensureUploadDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.uploadDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create KYC upload directory:', error);
      throw new Error('Failed to initialize KYC storage');
    }
  }

  private encryptFile(buffer: Buffer): { encryptedData: Buffer; iv: string } {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(buffer),
      cipher.final()
    ]);

    return {
      encryptedData: encrypted,
      iv: iv.toString('hex')
    };
  }

  private decryptFile(encryptedData: Buffer, iv: string): Buffer {
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
    
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ]);

    return decrypted;
  }

  private async saveFileToCloudinary(file: FileUpload, userId: string, documentType: string): Promise<IKYCDocument> {
    try {
      // Upload to Cloudinary (with optional encryption)
      const uploadResult = await cloudinaryService.uploadKYCDocument(
        file.buffer,
        file.originalname,
        userId,
        documentType
      );

      return {
        type: documentType as any,
        filename: uploadResult.public_id,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        cloudinaryPublicId: uploadResult.public_id,
        cloudinarySecureUrl: uploadResult.secure_url,
        encrypted: uploadResult.encrypted,
        encryptionIv: uploadResult.encryption_iv,
        uploadedAt: new Date(),
      };
    } catch (error) {
      logger.error('Failed to save file to Cloudinary', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId,
        documentType,
        filename: file.originalname,
      });
      throw error;
    }
  }

  // Keep the old method for backward compatibility
  private async saveEncryptedFile(file: FileUpload, userId: string, documentType: string): Promise<IKYCDocument> {
    const { encryptedData, iv } = this.encryptFile(file.buffer);
    const filename = `${userId}_${documentType}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const filePath = path.join(this.uploadDir, filename);

    // Save encrypted file with IV prepended
    const fileWithIv = Buffer.concat([Buffer.from(iv, 'hex'), encryptedData]);
    await fs.writeFile(filePath, fileWithIv);

    return {
      type: documentType as any,
      filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      encryptedPath: filePath,
      uploadedAt: new Date(),
    };
  }

  async submitKYC(
    userId: string,
    submissionData: KYCSubmissionData,
    files: FileUpload[],
    ipAddress?: string
  ): Promise<IKYCSubmission> {
    try {
      // Check if user exists
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check if KYC submission already exists
      const existingSubmission = await KYCSubmission.findOne({ userId });
      if (existingSubmission) {
        throw new Error('KYC submission already exists for this user');
      }

      // Validate age (must be 18 or older)
      const birthDate = new Date(submissionData.dateOfBirth);
      const age = new Date().getFullYear() - birthDate.getFullYear();
      if (age < 18) {
        throw new Error('User must be at least 18 years old');
      }

      // Process and encrypt uploaded files
      const documents: IKYCDocument[] = [];
      const accreditedVerificationDocs: IKYCDocument[] = [];

      for (const file of files) {
        // Validate file type and size
        if (!this.isValidFileType(file.mimetype)) {
          throw new Error(`Invalid file type: ${file.mimetype}`);
        }

        if (file.size > 10 * 1024 * 1024) { // 10MB limit
          throw new Error(`File too large: ${file.originalname}`);
        }

        // Determine document type from fieldname
        const documentType = this.getDocumentTypeFromFieldname(file.fieldname);
        const encryptedDoc = await this.saveFileToCloudinary(file, userId, documentType);

        if (file.fieldname.startsWith('accredited_')) {
          accreditedVerificationDocs.push(encryptedDoc);
        } else {
          documents.push(encryptedDoc);
        }
      }

      // Validate required documents
      if (documents.length === 0) {
        throw new Error('At least one identity document is required');
      }

      // Create KYC submission
      const kycSubmission = new KYCSubmission({
        userId,
        status: 'pending',
        submittedAt: new Date(),
        firstName: submissionData.firstName,
        lastName: submissionData.lastName,
        dateOfBirth: birthDate,
        nationality: submissionData.nationality,
        phoneNumber: submissionData.phoneNumber,
        address: submissionData.address,
        documents,
        accreditedInvestor: {
          claimed: submissionData.accreditedInvestor?.claimed || false,
          type: submissionData.accreditedInvestor?.type,
          annualIncome: submissionData.accreditedInvestor?.annualIncome,
          netWorth: submissionData.accreditedInvestor?.netWorth,
          professionalCertification: submissionData.accreditedInvestor?.professionalCertification,
          entityType: submissionData.accreditedInvestor?.entityType,
          verificationDocuments: accreditedVerificationDocs,
        },
        auditLog: [{
          action: 'KYC_SUBMITTED',
          performedBy: new mongoose.Types.ObjectId(userId),
          timestamp: new Date(),
          details: 'Initial KYC submission',
          ipAddress,
        }],
      });

      await kycSubmission.save();

      // Update user KYC status
      user.kycStatus = 'pending';
      await user.save();

      logger.info('KYC submission created', {
        userId,
        submissionId: kycSubmission._id,
        documentsCount: documents.length,
        accreditedClaimed: submissionData.accreditedInvestor?.claimed,
      });

      securityLogger.info('KYC submission', {
        userId,
        submissionId: kycSubmission._id,
        ipAddress,
        documentsUploaded: documents.length,
      });

      return kycSubmission;

    } catch (error) {
      logger.error('KYC submission failed:', error);
      throw error;
    }
  }

  async getKYCStatus(userId: string): Promise<{ status: string; submission?: IKYCSubmission }> {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const submission = await KYCSubmission.findOne({ userId }).populate('reviewedBy', 'email');

      return {
        status: user.kycStatus,
        submission: submission || undefined,
      };

    } catch (error) {
      logger.error('Failed to get KYC status:', error);
      throw error;
    }
  }

  async getPendingSubmissions(limit: number = 50, offset: number = 0): Promise<{
    submissions: IKYCSubmission[];
    total: number;
  }> {
    try {
      const [submissions, total] = await Promise.all([
        KYCSubmission.find({ status: 'pending' })
          .populate('userId', 'email createdAt')
          .sort({ submittedAt: 1 }) // Oldest first
          .limit(limit)
          .skip(offset),
        KYCSubmission.countDocuments({ status: 'pending' }),
      ]);

      return { submissions, total };

    } catch (error) {
      logger.error('Failed to get pending KYC submissions:', error);
      throw error;
    }
  }

  async getKYCStatistics(): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    accreditedInvestors: number;
    averageProcessingTime: number;
    recentSubmissions: number;
  }> {
    try {
      const [
        total,
        pending,
        approved,
        rejected,
        accreditedInvestors,
        recentSubmissions,
        processingTimes
      ] = await Promise.all([
        KYCSubmission.countDocuments(),
        KYCSubmission.countDocuments({ status: 'pending' }),
        KYCSubmission.countDocuments({ status: 'approved' }),
        KYCSubmission.countDocuments({ status: 'rejected' }),
        User.countDocuments({ accreditedInvestor: true }),
        KYCSubmission.countDocuments({
          submittedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
        }),
        KYCSubmission.find({
          status: { $in: ['approved', 'rejected'] },
          reviewedAt: { $exists: true },
          submittedAt: { $exists: true }
        }).select('submittedAt reviewedAt')
      ]);

      // Calculate average processing time in hours
      let averageProcessingTime = 0;
      if (processingTimes.length > 0) {
        const totalProcessingTime = processingTimes.reduce((sum, submission) => {
          const processingTime = new Date(submission.reviewedAt!).getTime() - new Date(submission.submittedAt).getTime();
          return sum + processingTime;
        }, 0);
        averageProcessingTime = Math.round(totalProcessingTime / processingTimes.length / (1000 * 60 * 60)); // Convert to hours
      }

      return {
        total,
        pending,
        approved,
        rejected,
        accreditedInvestors,
        averageProcessingTime,
        recentSubmissions,
      };

    } catch (error) {
      logger.error('Failed to get KYC statistics:', error);
      throw error;
    }
  }

  async approveKYC(
    submissionId: string,
    adminId: string,
    notes?: string,
    ipAddress?: string
  ): Promise<IKYCSubmission> {
    try {
      const submission = await KYCSubmission.findById(submissionId);
      if (!submission) {
        throw new Error('KYC submission not found');
      }

      if (submission.status !== 'pending') {
        throw new Error('KYC submission is not in pending status');
      }

      // Verify accredited investor claims if applicable
      let accreditedInvestorApproved = false;
      if (submission.accreditedInvestor.claimed) {
        accreditedInvestorApproved = await this.verifyAccreditedInvestorClaim(submission);
        
        // Add audit log for accredited investor verification
        submission.auditLog.push({
          action: 'ACCREDITED_INVESTOR_VERIFIED',
          performedBy: new mongoose.Types.ObjectId(adminId),
          timestamp: new Date(),
          details: `Accredited investor status: ${accreditedInvestorApproved ? 'APPROVED' : 'REJECTED'}. Type: ${submission.accreditedInvestor.type}`,
          ipAddress,
        });
      }

      // Update submission status
      submission.status = 'approved';
      submission.reviewedAt = new Date();
      submission.reviewedBy = new mongoose.Types.ObjectId(adminId);
      submission.reviewNotes = notes;

      // Add audit log entry
      submission.auditLog.push({
        action: 'KYC_APPROVED',
        performedBy: new mongoose.Types.ObjectId(adminId),
        timestamp: new Date(),
        details: `KYC approved by admin. ${notes || ''}`,
        ipAddress,
      });

      await submission.save();

      // Update user status
      const user = await User.findById(submission.userId);
      if (user) {
        const previousKycStatus = user.kycStatus;
        user.kycStatus = 'approved';
        
        // Set accredited investor status if claimed and approved
        if (submission.accreditedInvestor.claimed && accreditedInvestorApproved) {
          user.accreditedInvestor = true;
        }
        
        await user.save();

        // Log user status change
        logger.info('User KYC status updated', {
          userId: user._id,
          previousStatus: previousKycStatus,
          newStatus: user.kycStatus,
          accreditedInvestor: user.accreditedInvestor,
          adminId,
        });
      }

      logger.info('KYC approved', {
        submissionId,
        userId: submission.userId,
        adminId,
        accreditedInvestor: submission.accreditedInvestor.claimed,
        accreditedInvestorApproved,
      });

      securityLogger.info('KYC approval', {
        submissionId,
        userId: submission.userId,
        adminId,
        accreditedInvestorClaimed: submission.accreditedInvestor.claimed,
        accreditedInvestorApproved,
        ipAddress,
      });

      return submission;

    } catch (error) {
      logger.error('KYC approval failed:', error);
      throw error;
    }
  }

  async rejectKYC(
    submissionId: string,
    adminId: string,
    reason: string,
    notes?: string,
    ipAddress?: string
  ): Promise<IKYCSubmission> {
    try {
      const submission = await KYCSubmission.findById(submissionId);
      if (!submission) {
        throw new Error('KYC submission not found');
      }

      if (submission.status !== 'pending') {
        throw new Error('KYC submission is not in pending status');
      }

      // Update submission status
      submission.status = 'rejected';
      submission.reviewedAt = new Date();
      submission.reviewedBy = new mongoose.Types.ObjectId(adminId);
      submission.rejectionReason = reason;
      submission.reviewNotes = notes;

      // Add audit log entry
      submission.auditLog.push({
        action: 'KYC_REJECTED',
        performedBy: new mongoose.Types.ObjectId(adminId),
        timestamp: new Date(),
        details: `KYC rejected by admin. Reason: ${reason}. ${notes || ''}`,
        ipAddress,
      });

      await submission.save();

      // Update user status
      const user = await User.findById(submission.userId);
      if (user) {
        user.kycStatus = 'rejected';
        await user.save();
      }

      logger.info('KYC rejected', {
        submissionId,
        userId: submission.userId,
        adminId,
        reason,
      });

      securityLogger.info('KYC rejection', {
        submissionId,
        userId: submission.userId,
        adminId,
        reason,
        ipAddress,
      });

      return submission;

    } catch (error) {
      logger.error('KYC rejection failed:', error);
      throw error;
    }
  }

  private isValidFileType(mimeType: string): boolean {
    const allowedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'application/pdf',
      'image/webp',
    ];
    return allowedTypes.includes(mimeType);
  }

  private getDocumentTypeFromFieldname(fieldname: string): string {
    const mapping: { [key: string]: string } = {
      'passport': 'passport',
      'drivers_license': 'drivers_license',
      'national_id': 'national_id',
      'proof_of_address': 'proof_of_address',
      'bank_statement': 'bank_statement',
      'accredited_income': 'other',
      'accredited_net_worth': 'other',
      'accredited_professional': 'other',
      'accredited_entity': 'other',
    };

    return mapping[fieldname] || 'other';
  }

  private async verifyAccreditedInvestorClaim(submission: IKYCSubmission): Promise<boolean> {
    const accredited = submission.accreditedInvestor;
    
    if (!accredited.claimed || !accredited.type) {
      return false;
    }

    // Verify based on accredited investor type
    switch (accredited.type) {
      case 'income':
        // Individual with annual income > $200k (or $300k joint) for last 2 years
        if (!accredited.annualIncome || accredited.annualIncome < 200000) {
          logger.warn('Accredited investor income verification failed', {
            submissionId: submission._id,
            claimedIncome: accredited.annualIncome,
            requiredIncome: 200000,
          });
          return false;
        }
        
        // Check if supporting documents are provided
        if (!accredited.verificationDocuments || accredited.verificationDocuments.length === 0) {
          logger.warn('Accredited investor income verification failed: no supporting documents', {
            submissionId: submission._id,
          });
          return false;
        }
        
        logger.info('Accredited investor income verification passed', {
          submissionId: submission._id,
          income: accredited.annualIncome,
          documentsProvided: accredited.verificationDocuments.length,
        });
        return true;

      case 'net_worth':
        // Individual or joint net worth > $1M (excluding primary residence)
        if (!accredited.netWorth || accredited.netWorth < 1000000) {
          logger.warn('Accredited investor net worth verification failed', {
            submissionId: submission._id,
            claimedNetWorth: accredited.netWorth,
            requiredNetWorth: 1000000,
          });
          return false;
        }
        
        // Check if supporting documents are provided
        if (!accredited.verificationDocuments || accredited.verificationDocuments.length === 0) {
          logger.warn('Accredited investor net worth verification failed: no supporting documents', {
            submissionId: submission._id,
          });
          return false;
        }
        
        logger.info('Accredited investor net worth verification passed', {
          submissionId: submission._id,
          netWorth: accredited.netWorth,
          documentsProvided: accredited.verificationDocuments.length,
        });
        return true;

      case 'professional':
        // Licensed professionals (Series 7, 65, 82, etc.)
        if (!accredited.professionalCertification) {
          logger.warn('Accredited investor professional verification failed: no certification provided', {
            submissionId: submission._id,
          });
          return false;
        }
        
        // Validate professional certification types
        const validCertifications = ['series_7', 'series_65', 'series_82', 'cpa', 'cfa', 'other'];
        if (!validCertifications.includes(accredited.professionalCertification.toLowerCase())) {
          logger.warn('Accredited investor professional verification failed: invalid certification', {
            submissionId: submission._id,
            certification: accredited.professionalCertification,
          });
          return false;
        }
        
        logger.info('Accredited investor professional verification passed', {
          submissionId: submission._id,
          certification: accredited.professionalCertification,
        });
        return true;

      case 'entity':
        // Entities with > $5M in assets or all equity owners are accredited
        if (!accredited.entityType) {
          logger.warn('Accredited investor entity verification failed: no entity type provided', {
            submissionId: submission._id,
          });
          return false;
        }
        
        // Validate entity types
        const validEntityTypes = ['corporation', 'partnership', 'llc', 'trust', 'bank', 'insurance_company', 'investment_company'];
        if (!validEntityTypes.includes(accredited.entityType.toLowerCase())) {
          logger.warn('Accredited investor entity verification failed: invalid entity type', {
            submissionId: submission._id,
            entityType: accredited.entityType,
          });
          return false;
        }
        
        logger.info('Accredited investor entity verification passed', {
          submissionId: submission._id,
          entityType: accredited.entityType,
        });
        return true;

      default:
        logger.warn('Accredited investor verification failed: unknown type', {
          submissionId: submission._id,
          type: accredited.type,
        });
        return false;
    }
  }

  async getEncryptedDocument(submissionId: string, filename: string, requesterId: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }> {
    try {
      // Verify requester has permission to access the document
      const submission = await KYCSubmission.findById(submissionId);
      if (!submission) {
        throw new Error('KYC submission not found');
      }

      // Check if requester is the owner or an admin
      const requester = await User.findById(requesterId);
      if (!requester) {
        throw new Error('Requester not found');
      }

      const isOwner = submission.userId.toString() === requesterId;
      const isAdmin = requester.role === 'admin';

      if (!isOwner && !isAdmin) {
        throw new Error('Unauthorized access to KYC document');
      }

      // Find the document
      const allDocs = [...submission.documents, ...(submission.accreditedInvestor.verificationDocuments || [])];
      const document = allDocs.find(doc => doc.filename === filename);

      if (!document) {
        throw new Error('Document not found');
      }

      let buffer: Buffer;

      // Check if document is stored in Cloudinary or local file system
      if (document.cloudinaryPublicId) {
        // Download from Cloudinary
        buffer = await cloudinaryService.downloadKYCDocument(
          document.cloudinaryPublicId,
          document.encryptionIv
        );
      } else if (document.encryptedPath) {
        // Fallback to local file system (backward compatibility)
        const encryptedFileWithIv = await fs.readFile(document.encryptedPath);
        const iv = encryptedFileWithIv.slice(0, 16).toString('hex');
        const encryptedData = encryptedFileWithIv.slice(16);
        buffer = this.decryptFile(encryptedData, iv);
      } else {
        throw new Error('Document storage location not found');
      }

      securityLogger.info('KYC document accessed', {
        submissionId,
        filename,
        requesterId,
        isAdmin,
        storageType: document.cloudinaryPublicId ? 'cloudinary' : 'local',
      });

      return {
        buffer,
        mimeType: document.mimeType,
        originalName: document.originalName,
      };

    } catch (error) {
      logger.error('Failed to retrieve KYC document:', error);
      throw error;
    }
  }
}

export const kycService = new KYCService();