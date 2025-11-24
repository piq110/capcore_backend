import mongoose, { Document, Schema } from 'mongoose';

export interface IKYCDocument {
  type: 'passport' | 'drivers_license' | 'national_id' | 'proof_of_address' | 'bank_statement' | 'other';
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  // For backward compatibility, keep encryptedPath but make it optional
  encryptedPath?: string;
  // New Cloudinary fields
  cloudinaryPublicId?: string;
  cloudinarySecureUrl?: string;
  encrypted?: boolean;
  encryptionIv?: string;
  uploadedAt: Date;
}

export interface IKYCSubmission extends Document {
  userId: mongoose.Types.ObjectId;
  status: 'pending' | 'approved' | 'rejected' | 'requires_additional_info';
  submittedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  
  // Personal Information
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  nationality: string;
  phoneNumber: string;
  
  // Address Information
  address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  
  // Identity Documents
  documents: IKYCDocument[];
  
  // Accredited Investor Information
  accreditedInvestor: {
    claimed: boolean;
    type?: 'income' | 'net_worth' | 'professional' | 'entity';
    annualIncome?: number;
    netWorth?: number;
    professionalCertification?: string;
    entityType?: string;
    verificationDocuments?: IKYCDocument[];
  };
  
  // Review Information
  reviewNotes?: string;
  rejectionReason?: string;
  additionalInfoRequired?: string;
  
  // Audit Trail
  auditLog: {
    action: string;
    performedBy: mongoose.Types.ObjectId;
    timestamp: Date;
    details?: string;
    ipAddress?: string;
  }[];
  
  createdAt: Date;
  updatedAt: Date;
}

const kycDocumentSchema = new Schema<IKYCDocument>({
  type: {
    type: String,
    enum: ['passport', 'drivers_license', 'national_id', 'proof_of_address', 'bank_statement', 'other'],
    required: true,
  },
  filename: {
    type: String,
    required: true,
  },
  originalName: {
    type: String,
    required: true,
  },
  mimeType: {
    type: String,
    required: true,
  },
  size: {
    type: Number,
    required: true,
  },
  // For backward compatibility
  encryptedPath: {
    type: String,
    required: false,
  },
  // New Cloudinary fields
  cloudinaryPublicId: {
    type: String,
    required: false,
  },
  cloudinarySecureUrl: {
    type: String,
    required: false,
  },
  encrypted: {
    type: Boolean,
    default: false,
  },
  encryptionIv: {
    type: String,
    required: false,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const kycSubmissionSchema = new Schema<IKYCSubmission>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'requires_additional_info'],
    default: 'pending',
  },
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  reviewedAt: {
    type: Date,
  },
  reviewedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  
  // Personal Information
  firstName: {
    type: String,
    required: true,
    trim: true,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
  },
  dateOfBirth: {
    type: Date,
    required: true,
  },
  nationality: {
    type: String,
    required: true,
    trim: true,
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true,
  },
  
  // Address Information
  address: {
    street: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    postalCode: {
      type: String,
      required: true,
      trim: true,
    },
    country: {
      type: String,
      required: true,
      trim: true,
    },
  },
  
  // Identity Documents
  documents: [kycDocumentSchema],
  
  // Accredited Investor Information
  accreditedInvestor: {
    claimed: {
      type: Boolean,
      default: false,
    },
    type: {
      type: String,
      enum: ['income', 'net_worth', 'professional', 'entity'],
    },
    annualIncome: {
      type: Number,
    },
    netWorth: {
      type: Number,
    },
    professionalCertification: {
      type: String,
    },
    entityType: {
      type: String,
    },
    verificationDocuments: [kycDocumentSchema],
  },
  
  // Review Information
  reviewNotes: {
    type: String,
  },
  rejectionReason: {
    type: String,
  },
  additionalInfoRequired: {
    type: String,
  },
  
  // Audit Trail
  auditLog: [{
    action: {
      type: String,
      required: true,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    details: {
      type: String,
    },
    ipAddress: {
      type: String,
    },
  }],
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc: any, ret: any) {
      // Don't expose encrypted file paths in JSON responses
      if (ret.documents) {
        ret.documents = ret.documents.map((doc: any) => ({
          type: doc.type,
          filename: doc.filename,
          originalName: doc.originalName,
          mimeType: doc.mimeType,
          size: doc.size,
          uploadedAt: doc.uploadedAt,
        }));
      }
      if (ret.accreditedInvestor?.verificationDocuments) {
        ret.accreditedInvestor.verificationDocuments = ret.accreditedInvestor.verificationDocuments.map((doc: any) => ({
          type: doc.type,
          filename: doc.filename,
          originalName: doc.originalName,
          mimeType: doc.mimeType,
          size: doc.size,
          uploadedAt: doc.uploadedAt,
        }));
      }
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for performance
kycSubmissionSchema.index({ userId: 1 });
kycSubmissionSchema.index({ status: 1 });
kycSubmissionSchema.index({ submittedAt: -1 });
kycSubmissionSchema.index({ reviewedAt: -1 });
kycSubmissionSchema.index({ reviewedBy: 1 });

// Add audit log entry middleware
kycSubmissionSchema.methods.addAuditEntry = function(action: string, performedBy: mongoose.Types.ObjectId, details?: string, ipAddress?: string) {
  this.auditLog.push({
    action,
    performedBy,
    timestamp: new Date(),
    details,
    ipAddress,
  });
};

export const KYCSubmission = mongoose.model<IKYCSubmission>('KYCSubmission', kycSubmissionSchema);