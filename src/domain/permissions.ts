export const Permissions = {
    INVENTORY_READ: "inventory.read",
    INVENTORY_CREATE: "inventory.create",
    INVENTORY_UPDATE: "inventory.update",
    INVENTORY_ADJUST: "inventory.adjust",
    PURCHASE_READ: "purchase.read",
    PURCHASE_CREATE: "purchase.create",
    PURCHASE_APPROVE: "purchase.approve",
    PURCHASE_RECEIVE: "purchase.receive",
    PURCHASE_RETURN: "purchase.return",
    PRODUCT_READ: "product.read",
    PRODUCT_CREATE: "product.create",
    PRODUCT_UPDATE: "product.update",
    CUSTOMER_READ: "customer.read",
    CUSTOMER_CREATE: "customer.create",
    PRESCRIPTION_READ: "prescription.read",
    PRESCRIPTION_CREATE: "prescription.create",
    QUALITY_CONTROL_READ: "quality-control.read",
    QUALITY_CONTROL_MANAGE: "quality-control.manage",
    REPORTS_READ: "reports.read",
    FINANCE_READ: "finance.read",
    FINANCE_WRITE: "finance.write",
    USERS_MANAGE: "users.manage",
    SETTINGS_MANAGE: "settings.manage",
    ALERTS_MANAGE: "alerts.manage",
    SUPPLIER_READ: "supplier.read",
    SUPPLIER_CREATE: "supplier.create",
    SUPPLIER_UPDATE: "supplier.update",
    SALE_CREATE: "sale.create",
    SALE_READ: "sale.read",
    SALE_RETURN: "sale.return",
    DASHBOARD_READ: "dashboard.read",
    AUDIT_READ: "audit.read",
    SUBSCRIPTION_READ: "subscription.read",
    SUBSCRIPTION_MANAGE: "subscription.manage"
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const rolePermissions: Record<string, Permission[]> = {
    SUPER_ADMIN: Object.values(Permissions),
    OWNER: Object.values(Permissions),    MANAGER: [
        Permissions.INVENTORY_READ,
        Permissions.INVENTORY_CREATE,
        Permissions.INVENTORY_UPDATE,
        Permissions.INVENTORY_ADJUST,
        Permissions.PURCHASE_READ,
        Permissions.PURCHASE_CREATE,
        Permissions.PURCHASE_APPROVE,
        Permissions.PURCHASE_RECEIVE,
        Permissions.PURCHASE_RETURN,
        Permissions.PRODUCT_READ,
        Permissions.PRODUCT_CREATE,
        Permissions.PRODUCT_UPDATE,
        Permissions.CUSTOMER_READ,
        Permissions.CUSTOMER_CREATE,
        Permissions.PRESCRIPTION_READ,
        Permissions.PRESCRIPTION_CREATE,
        Permissions.QUALITY_CONTROL_READ,
        Permissions.QUALITY_CONTROL_MANAGE,
        Permissions.REPORTS_READ,
        Permissions.FINANCE_READ,
        Permissions.ALERTS_MANAGE,
        Permissions.SUPPLIER_READ,
        Permissions.SUPPLIER_CREATE,
        Permissions.SUPPLIER_UPDATE,
        Permissions.SALE_CREATE,
        Permissions.SALE_READ,
        Permissions.SALE_RETURN,
        Permissions.DASHBOARD_READ
    ],
    PHARMACIST: [
        Permissions.INVENTORY_READ,
        Permissions.PRODUCT_READ,
        Permissions.CUSTOMER_READ,
        Permissions.CUSTOMER_CREATE,
        Permissions.PRESCRIPTION_READ,
        Permissions.PRESCRIPTION_CREATE,
        Permissions.QUALITY_CONTROL_READ,
        Permissions.SALE_CREATE,
        Permissions.SALE_READ,
        Permissions.SALE_RETURN,
        Permissions.DASHBOARD_READ
    ],
    STAFF: [
        Permissions.INVENTORY_READ,
        Permissions.PRODUCT_READ,
        Permissions.CUSTOMER_READ,
        Permissions.SALE_CREATE,
        Permissions.SALE_READ,
        Permissions.SALE_RETURN,
        Permissions.DASHBOARD_READ
    ]
};

export function permissionsForRole(role: string): Permission[] {
    return rolePermissions[role] ?? [];
}
