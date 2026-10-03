import { Router } from "express";
import authRoutes from "./auth.routes.js";
import branchRoutes from "./branch.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import productRoutes from "./product.routes.js";
import inventoryRoutes from "./inventory.routes.js";
import supplierRoutes from "./supplier.routes.js";
import purchaseRoutes from "./purchase.routes.js";
import customerRoutes from "./customer.routes.js";
import saleRoutes from "./sale.routes.js";
import prescriptionRoutes from "./prescription.routes.js";
import qualityControlRoutes from "./quality-control.routes.js";
import alertRoutes from "./alert.routes.js";
import reportRoutes from "./report.routes.js";
import userRoutes from "./user.routes.js";
import organizationRoutes from "./organization.routes.js";
import subscriptionRoutes from "./subscription.routes.js";
import adminSubscriptionRoutes from "./admin-subscription.routes.js";
import financeRoutes from "./finance.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" }, message: null });
});

router.use("/auth", authRoutes);
router.use("/branches", branchRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/products", productRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/suppliers", supplierRoutes);
router.use("/purchases", purchaseRoutes);
router.use("/customers", customerRoutes);
router.use("/sales", saleRoutes);
router.use("/prescriptions", prescriptionRoutes);
router.use("/quality-control", qualityControlRoutes);
router.use("/alerts", alertRoutes);
router.use("/reports", reportRoutes);
router.use("/users", userRoutes);
router.use("/organization", organizationRoutes);
router.use("/subscription", subscriptionRoutes);
router.use("/admin/subscriptions", adminSubscriptionRoutes);
router.use("/finance", financeRoutes);

export default router;