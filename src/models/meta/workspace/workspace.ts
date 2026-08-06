import { Document, model, Schema, Types } from "mongoose";

export interface IWorkspace extends Document {
  workspaceCode: string;
  name: string;
  displayName?: string;
  description?: string;

  type:
    | "SinglePharmacy"
    | "Warehouse"
    | "ChainBranch"
    | "ManufacturingUnit"
    | "Distributor"
    | "Hospital"
    | "ResearchLab";

  parentWorkspace?: Types.ObjectId;

  logoUrl?: string;
  website?: string;

  users: Types.ObjectId[];
  adminUser: Types.ObjectId;

  // Contact
  email: string;
  phone: string;
  alternatePhone?: string;

  // Compliance
  drugLicenseNumber: string;
  gstinOrTaxId?: string;
  panNumber?: string;
  cinNumber?: string;
  fssaiNumber?: string;
  registrationNumber?: string;

  regulatoryAuthority?: "CDSCO" | "FDA" | "EMA" | "MHRA" | "WHO_GMP" | "OTHER";

  gmpCertified: boolean;
  gdpCertified: boolean;

  isoCertifications: string[];

  address: {
    street: string;
    area?: string;
    city: string;
    district?: string;
    state: string;
    zipCode: string;
    country: string;

    latitude?: number;
    longitude?: number;
  };

  settings: {
    currency: string;
    timezone: string;
    language: string;

    lowStockAlertThreshold: number;

    allowNegativeStock: boolean;

    batchTrackingEnabled: boolean;
    expiryTrackingEnabled: boolean;
    serialTrackingEnabled: boolean;

    autoGenerateBatchNumbers: boolean;
    requireQAApproval: boolean;
    requireDigitalSignature: boolean;
  };

  modules: {
    inventory: boolean;
    procurement: boolean;
    sales: boolean;
    crm: boolean;
    finance: boolean;

    manufacturing: boolean;
    qualityControl: boolean;
    lims: boolean;

    hrms: boolean;
    reports: boolean;
  };

  subscription: {
    plan: "Trial" | "Starter" | "Professional" | "Enterprise" | "Custom";

    status: "Active" | "Expired" | "Cancelled" | "Suspended";

    startDate?: Date;
    endDate?: Date;

    maxUsers: number;
    maxStorageGB: number;
  };

  security: {
    twoFactorAuthEnabled: boolean;
    sessionTimeoutMinutes: number;
    passwordExpiryDays: number;
    auditLoggingEnabled: boolean;
  };

  isActive: boolean;

  status: "Active" | "Suspended" | "Inactive";

  metadata?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

const workspaceSchema = new Schema<IWorkspace>(
  {
    workspaceCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
      uppercase: true,
      trim: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    displayName: { type: String, trim: true },

    description: { type: String, trim: true },

    type: {
      type: String,
      required: true,
      enum: [
        "SinglePharmacy",
        "Warehouse",
        "ChainBranch",
        "ManufacturingUnit",
        "Distributor",
        "Hospital",
        "ResearchLab",
      ],
      default: "SinglePharmacy",
    },

    logoUrl: String,

    website: String,

    users: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    adminUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
    },

    alternatePhone: String,

    drugLicenseNumber: {
      type: String,
      required: true,
      unique: true,
    },

    gstinOrTaxId: String,

    panNumber: String,

    cinNumber: String,

    fssaiNumber: String,

    registrationNumber: String,

    regulatoryAuthority: {
      type: String,
      enum: ["CDSCO", "FDA", "EMA", "MHRA", "WHO_GMP", "OTHER"],
      default: "CDSCO",
    },

    gmpCertified: {
      type: Boolean,
      default: false,
    },

    gdpCertified: {
      type: Boolean,
      default: false,
    },

    isoCertifications: {
      type: [String],
      default: [],
    },

    address: {
      street: String,

      area: String,

      city: String,

      district: String,

      state: String,

      zipCode: String,

      country: {
        type: String,
        default: "India",
      },

      latitude: Number,

      longitude: Number,
    },

    settings: {
      currency: {
        type: String,
        default: "INR",
      },

      timezone: {
        type: String,
        default: "Asia/Kolkata",
      },

      language: {
        type: String,
        default: "en",
      },

      lowStockAlertThreshold: {
        type: Number,
        default: 10,
      },

      allowNegativeStock: {
        type: Boolean,
        default: false,
      },

      batchTrackingEnabled: {
        type: Boolean,
        default: true,
      },

      expiryTrackingEnabled: {
        type: Boolean,
        default: true,
      },

      serialTrackingEnabled: {
        type: Boolean,
        default: false,
      },

      autoGenerateBatchNumbers: {
        type: Boolean,
        default: true,
      },

      requireQAApproval: {
        type: Boolean,
        default: true,
      },

      requireDigitalSignature: {
        type: Boolean,
        default: false,
      },
    },

    modules: {
      inventory: {
        type: Boolean,
        default: true,
      },

      procurement: {
        type: Boolean,
        default: true,
      },

      sales: {
        type: Boolean,
        default: true,
      },

      crm: {
        type: Boolean,
        default: false,
      },

      finance: {
        type: Boolean,
        default: true,
      },

      manufacturing: {
        type: Boolean,
        default: false,
      },

      qualityControl: {
        type: Boolean,
        default: false,
      },

      lims: {
        type: Boolean,
        default: false,
      },

      hrms: {
        type: Boolean,
        default: false,
      },

      reports: {
        type: Boolean,
        default: true,
      },
    },

    subscription: {
      plan: {
        type: String,
        enum: ["Trial", "Starter", "Professional", "Enterprise", "Custom"],
        default: "Trial",
      },

      status: {
        type: String,
        enum: ["Active", "Expired", "Cancelled", "Suspended"],
        default: "Active",
      },

      startDate: Date,

      endDate: Date,

      maxUsers: {
        type: Number,
        default: 10,
      },

      maxStorageGB: {
        type: Number,
        default: 5,
      },
    },

    security: {
      twoFactorAuthEnabled: {
        type: Boolean,
        default: false,
      },

      sessionTimeoutMinutes: {
        type: Number,
        default: 30,
      },

      passwordExpiryDays: {
        type: Number,
        default: 90,
      },

      auditLoggingEnabled: {
        type: Boolean,
        default: true,
      },
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      enum: ["Active", "Suspended", "Inactive"],
      default: "Active",
    },
  },
  {
    timestamps: true,
  },
);

export const Workspace = model<IWorkspace>("Workspace", workspaceSchema);
