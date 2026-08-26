import { Router } from "express";
import authRoutes from "./auth.routes";
import branchRoutes from "./branch.routes";
import dashboardRoutes from "./dashboard.routes";
import productRoutes from "./product.routes";
import inventoryRoutes from "./inventory.routes";
import supplierRoutes from "./supplier.routes";
import purchaseRoutes from "./purchase.routes";
import customerRoutes from "./customer.routes";
import saleRoutes from "./sale.routes";
import prescriptionRoutes from "./prescription.routes";
import qualityControlRoutes from "./quality-control.routes";
import alertRoutes from "./alert.routes";
import reportRoutes from "./report.routes";
import userRoutes from "./user.routes";
import organizationRoutes from "./organization.routes";
import subscriptionRoutes from "./subscription.routes";
import adminSubscriptionRoutes from "./admin-subscription.routes";
import financeRoutes from "./finance.routes";

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