import { Document, model, Schema, Types } from "mongoose";

export interface IUser extends Document {
  fullName: string;
  email: string;
  phone: string;

  password: string;

  avatarUrl?: string;

  workspace: Types.ObjectId;

  role:
    | "SuperAdmin"
    | "Owner"
    | "Admin"
    | "Manager"
    | "Pharmacist"
    | "Cashier"
    | "WarehouseStaff"
    | "SalesRep"
    | "Accountant";

  permissions?: string[];

  employeeId?: string;

  isEmailVerified: boolean;
  isPhoneVerified: boolean;

  twoFactorEnabled: boolean;

  lastLoginAt?: Date;

  status: "Active" | "Inactive" | "Suspended";

  metadata?: Record<string, any>;
  isAdmin: boolean;
  refreshTokenHash: string;

  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    password: {
      type: String,
      required: false,
      select: false, // Never return password by default
    },

    avatarUrl: String,

    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },

    role: {
      type: String,
      enum: [
        "SuperAdmin",
        "Owner",
        "Admin",
        "Manager",
        "Pharmacist",
        "Cashier",
        "WarehouseStaff",
        "SalesRep",
        "Accountant",
      ],
      default: "Owner",
    },

    permissions: {
      type: [String],
      default: [],
    },

    employeeId: String,

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    isPhoneVerified: {
      type: Boolean,
      default: false,
    },

    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },

    lastLoginAt: Date,

    status: {
      type: String,
      enum: ["Active", "Inactive", "Suspended"],
      default: "Active",
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    refreshTokenHash: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

export const User = model<IUser>("User", userSchema);
