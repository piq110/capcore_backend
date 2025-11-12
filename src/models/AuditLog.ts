import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
  userId?: mongoose.Types.ObjectId;
  adminId?: mongoose.Types.ObjectId;
  action: string;
  resource: string;
  resourceId?: string;
  details: any;
  ipAddress: string;
  userAgent?: string;
  timestamp: Date;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'auth' | 'user_management' | 'trading' | 'wallet' | 'kyc' | 'admin' | 'system' | 'security';
  success: boolean;
  errorMessage?: string;
  metadata?: any;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  adminId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  action: {
    type: String,
    required: true,
    index: true,
    maxlength: [100, 'Action cannot exceed 100 characters'],
  },
  resource: {
    type: String,
    required: true,
    index: true,
    maxlength: [50, 'Resource cannot exceed 50 characters'],
  },
  resourceId: {
    type: String,
    index: true,
    maxlength: [100, 'Resource ID cannot exceed 100 characters'],
  },
  details: {
    type: Schema.Types.Mixed,
    required: true,
  },
  ipAddress: {
    type: String,
    required: true,
    index: true,
  },
  userAgent: {
    type: String,
    maxlength: [500, 'User agent cannot exceed 500 characters'],
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low',
    index: true,
  },
  category: {
    type: String,
    enum: ['auth', 'user_management', 'trading', 'wallet', 'kyc', 'admin', 'system', 'security'],
    required: true,
    index: true,
  },
  success: {
    type: Boolean,
    required: true,
    index: true,
  },
  errorMessage: {
    type: String,
    maxlength: [1000, 'Error message cannot exceed 1000 characters'],
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

// Indexes for performance and querying
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ category: 1, timestamp: -1 });
auditLogSchema.index({ severity: 1, timestamp: -1 });
auditLogSchema.index({ success: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ adminId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ resource: 1, timestamp: -1 });
auditLogSchema.index({ ipAddress: 1, timestamp: -1 });

// Compound indexes for common queries
auditLogSchema.index({ category: 1, severity: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, category: 1, timestamp: -1 });
auditLogSchema.index({ success: 1, severity: 1, timestamp: -1 });

// TTL index to automatically delete old audit logs (optional - keep for compliance)
// auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 31536000 }); // 1 year

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);

// Helper function to create audit log entries
export const createAuditLog = async (data: {
  userId?: string;
  adminId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details: any;
  ipAddress: string;
  userAgent?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  category: 'auth' | 'user_management' | 'trading' | 'wallet' | 'kyc' | 'admin' | 'system' | 'security';
  success: boolean;
  errorMessage?: string;
  metadata?: any;
}): Promise<IAuditLog> => {
  const auditLog = new AuditLog({
    userId: data.userId ? new mongoose.Types.ObjectId(data.userId) : undefined,
    adminId: data.adminId ? new mongoose.Types.ObjectId(data.adminId) : undefined,
    action: data.action,
    resource: data.resource,
    resourceId: data.resourceId,
    details: data.details,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
    severity: data.severity || 'low',
    category: data.category,
    success: data.success,
    errorMessage: data.errorMessage,
    metadata: data.metadata,
  });

  return await auditLog.save();
};