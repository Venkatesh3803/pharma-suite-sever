import { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/* Deterministic PRNG so the seed is reproducible */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(1337);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const between = (min: number, max: number) => min + rnd() * (max - min);
const int = (min: number, max: number) => Math.floor(between(min, max + 1));
const round2 = (n: number) => Math.round(n * 100) / 100;

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};

/* ----------------------------------------------------------------------
 * Reference data
 * -------------------------------------------------------------------- */
const CATEGORIES = [
  "Analgesics", "Antibiotics", "Gastrointestinal", "Antihistamines",
  "Cardiac", "Diabetes", "Vitamins & Supplements", "Cough & Cold",
  "Dermatology", "Eye, Ear & Nasal", "Topical Pain Relief", "OTC & Wellness",
];

const SUPPLIERS = [
  { name: "A.J. Medical Distributors", person: "Rajesh Iyer", leadTime: 3, terms: "Net 30" },
  { name: "MedLife Distributors Pvt Ltd", person: "Sneha Reddy", leadTime: 5, terms: "Net 30" },
  { name: "Sunrise Pharma Agency", person: "Karthik Rao", leadTime: 2, terms: "Cash on delivery" },
  { name: "Bharat Medisales", person: "Amit Sharma", leadTime: 7, terms: "Net 45" },
  { name: "Sai Pharma Distributors", person: "Priya Nair", leadTime: 3, terms: "Net 30" },
  { name: "Curewell Agencies", person: "Naveen Kumar", leadTime: 4, terms: "Net 30" },
  { name: "New India Medical Agency", person: "Farhan Khan", leadTime: 6, terms: "Net 15" },
  { name: "HealthCare Home Agencies", person: "Divya Menon", leadTime: 2, terms: "Cash on delivery" },
  { name: "Milky Way Distributors", person: "Suresh Bhat", leadTime: 5, terms: "Net 30" },
  { name: "Union Pharma Supply", person: "Anita Desai", leadTime: 4, terms: "Net 30" },
  { name: "Alpha Medi-Distributors", person: "Vikram Singh", leadTime: 3, terms: "Net 30" },
  { name: "Best Care Pharma Mart", person: "Lakshmi Prasad", leadTime: 6, terms: "Net 45" },
];

/* brand, generic, manufacturer, strength, form, pack, gst, tier */
type P = [string, string, string, string, string, string, number, "A" | "B" | "C" | "D"];
const PRODUCTS: P[] = [
  // Fast movers (A)
  ["Dolo 650", "Paracetamol", "Micro Labs", "650mg", "Tablet", "15 tablets", 12, "A"],
  ["Crocin Advance", "Paracetamol", "GSK Pharmaceuticals", "500mg", "Tablet", "15 tablets", 12, "A"],
  ["Pan 40", "Pantoprazole", "Alkem Laboratories", "40mg", "Tablet", "15 tablets", 12, "A"],
  ["Combiflam", "Paracetamol + Ibuprofen", "Sanofi India", "325mg + 400mg", "Tablet", "10 tablets", 12, "A"],
  ["Ecosprin 75", "Aspirin", "USV", "75mg", "Tablet", "14 tablets", 12, "A"],
  ["Augmentin 625", "Amoxicillin + Clavulanic Acid", "GSK Pharmaceuticals", "500 + 125mg", "Tablet", "10 tablets", 12, "A"],
  ["Glycomet 500", "Metformin", "USV", "500mg", "Tablet", "20 tablets", 12, "A"],
  ["Azithral 500", "Azithromycin", "Alembic", "500mg", "Tablet", "5 tablets", 12, "A"],

  // Moderate movers (B)
  ["Calpol 650", "Paracetamol", "GSK Pharmaceuticals", "650mg", "Tablet", "15 tablets", 12, "B"],
  ["Ibuprofen 400", "Ibuprofen", "Zydus Cadila", "400mg", "Tablet", "10 tablets", 12, "B"],
  ["Shelcal 500", "Calcium + Vit D3", "Torrent Pharma", "500mg", "Tablet", "15 tablets", 12, "B"],
  ["Becosules", "B-Complex + Vit C", "Pfizer India", "—", "Capsule", "30 capsules", 12, "B"],
  ["Pantocid 40", "Pantoprazole", "Sun Pharma", "40mg", "Tablet", "15 tablets", 12, "B"],
  ["Domstal 10", "Domperidone", "Torrent Pharma", "10mg", "Tablet", "10 tablets", 12, "B"],
  ["Omez 20", "Omeprazole", "Dr Reddy's", "20mg", "Capsule", "15 capsules", 12, "B"],
  ["Rantac 150", "Ranitidine", "JB Chemicals", "150mg", "Tablet", "15 tablets", 12, "B"],
  ["Cetrizine 10", "Cetirizine", "Dr Reddy's", "10mg", "Tablet", "20 tablets", 12, "B"],
  ["Allegra 120", "Fexofenadine", "Sanofi India", "120mg", "Tablet", "10 tablets", 12, "B"],
  ["Telfast 180", "Fexofenadine", "Mankind Pharma", "180mg", "Tablet", "10 tablets", 12, "B"],
  ["Zyrtec", "Levocetirizine", "MSD India", "5mg", "Tablet", "10 tablets", 12, "B"],
  ["Amlong 5", "Amlodipine", "Micro Labs", "5mg", "Tablet", "15 tablets", 12, "B"],
  ["Telma 40", "Telmisartan", "Glenmark", "40mg", "Tablet", "30 tablets", 12, "B"],
  ["Lipicure 10", "Atorvastatin", "Cipla", "10mg", "Tablet", "15 tablets", 12, "B"],
  ["Rosuvas 10", "Rosuvastatin", "Sun Pharma", "10mg", "Tablet", "15 tablets", 12, "B"],
  ["Concor 5", "Bisoprolol", "Merck India", "5mg", "Tablet", "14 tablets", 12, "B"],
  ["Cardace 2.5", "Ramipril", "Sanofi India", "2.5mg", "Capsule", "10 capsules", 12, "B"],
  ["Derzit 50", "Sitagliptin", "Torrent Pharma", "50mg", "Tablet", "15 tablets", 12, "B"],
  ["Amaryl 1", "Glimepiride", "Sanofi India", "1mg", "Tablet", "15 tablets", 12, "B"],
  ["Augmentin 1000", "Amoxicillin + Clavulanic Acid", "GSK Pharmaceuticals", "875 + 125mg", "Tablet", "10 tablets", 12, "B"],
  ["Cefixime 200", "Cefixime", "Cipla", "200mg", "Tablet", "10 tablets", 12, "B"],
  ["Amoxycillin 500", "Amoxicillin", "Cipla", "500mg", "Capsule", "10 capsules", 12, "B"],
  ["ZiBAC 500", "Cefpodoxime", "Mankind Pharma", "500mg", "Tablet", "10 tablets", 12, "B"],

  // Slow movers (C)
  ["Doxypol 100", "Doxycycline", "Sun Pharma", "100mg", "Tablet", "8 tablets", 12, "C"],
  ["Ciprobid 500", "Ciprofloxacin", "Cipla", "500mg", "Tablet", "10 tablets", 12, "C"],
  ["Ascoril LS", "Ambroxol + Salbutamol", "Glenmark", "100ml syrup", "Syrup", "100 ml", 12, "C"],
  ["Benadryl 114ml", "Diphenhydramine", "Manus Aktteva", "2.5mg/5ml", "Syrup", "114 ml", 12, "C"],
  ["Digene", "Dried Aluminium Gel", "Abbott India", "—", "Tablet", "15 tablets", 12, "A"],
  ["Candid Dusting Powder", "Clotrimazole", "Glenmark", "1% w/w", "Powder", "75 g", 18, "C"],
  ["T-Bact Ointment", "Mupirocin", "GlaxoSmithKline", "2% w/w", "Ointment", "10 g", 18, "C"],
  ["Betnovate-N", "Betamethasone + Neomycin", "GlaxoSmithKline", "0.1% w/w", "Cream", "20 g", 18, "C"],
  ["Caladryl Lotion", "Pramoxine + Calamine", "Torrent Pharma", "—", "Lotion", "100 ml", 18, "C"],
  ["Itchguard Cream", "Miconazole", "Torrent Pharma", "2% w/w", "Cream", "15 g", 18, "C"],
  ["Optiva Solution A", "Hydroxypropyl Cellulose", "Dr Reddy's", "0.5% w/v", "Eye Drops", "10 ml", 18, "C"],
  ["Ocurest", "Carboxymethylcellulose", "Sun Pharma", "0.5% w/v", "Eye Drops", "10 ml", 18, "C"],
  ["Nasivion", "Xylometazoline", "Merck India", "0.1% w/v", "Nasal Drops", "10 ml", 18, "C"],
  ["Volini Gel", "Diclofenac", "Sun Pharma", "1% w/w", "Gel", "30 g", 18, "A"],
  ["Moov Cream", "Methyl Salicylate", "Reckitt Benckiser", "—", "Cream", "35 g", 18, "B"],
  ["Vicks Action 500", "Paracetamol + Phenylephrine", "Procter & Gamble", "325 + 5mg", "Tablet", "10 tablets", 12, "B"],
  ["Glucon-D", "Glucose", "Debco Pharmaceuticals", "—", "Powder", "500 g", 5, "C"],
  ["ORS Sachet", "Oral Rehydration Salts", "Cipla", "—", "Powder", "1 sachet", 5, "A"],
  ["Panadol Cold & Flu", "Paracetamol + Caffeine", "GSK Pharmaceuticals", "500mg", "Tablet", "10 tablets", 12, "B"],
  ["Cremaffin Plus", "Liquid Paraffin", "Abbott India", "—", "Syrup", "170 ml", 12, "C"],

  // Dead stock (D) — never sold in the simulation window
  ["Neurobion Forte", "B-Complex", "Procter & Gamble", "—", "Tablet", "30 tablets", 12, "D"],
  ["A to Z NS", "Multivitamin + Multimineral", "Apex Labs", "—", "Tablet", "30 tablets", 12, "D"],
  ["Zincovit", "Zinc + Multivitamin", "Apex Labs", "—", "Tablet", "15 tablets", 12, "D"],
  ["Calpol Paediatric", "Paracetamol", "GSK Pharmaceuticals", "160mg/5ml", "Syrup", "60 ml", 12, "D"],
  ["Aleve", "Naproxen", "Baymeda India", "250mg", "Tablet", "10 tablets", 12, "D"],
  ["Sporidex 250", "Cephalexin", "Sun Pharma", "250mg", "Capsule", "10 capsules", 12, "D"],
  ["Tramazac 50", "Tramadol", "Torrent Pharma", "50mg", "Capsule", "10 capsules", 12, "D"],
  ["Vitcofol", "Folic Acid + Iron", "Sun Pharma", "—", "Capsule", "15 capsules", 12, "C"],
  ["Liv-52 Tablets", "Ayurvedic Liver", "Himalaya", "—", "Tablet", "60 tablets", 12, "D"],
  ["Shallaki", "Boswellia", "Himalaya", "—", "Tablet", "60 tablets", 12, "D"],
  ["Septilin", "Immunomodulator", "Himalaya", "—", "Tablet", "60 tablets", 12, "D"],
];

const OTC_BRANDS = new Set(["Glucon-D", "ORS Sachet", "Digene", "Volini Gel", "Moov Cream"]);

/* upcoming expiry per product across buckets */
const EXPIRY_SHOWCASE: Record<string, number[]> = {
  "Shelcal 500": [5],
  "Rantac 150": [12],
  "Omez 20": [20],
  "Vitcofol": [28],
  "Doxypol 100": [45],
  "ZiBAC 500": [55],
  "Betnovate-N": [80],
  "Ciprobid 500": [160],
};

const EXPIRED_STOCK = ["Cremaffin Plus", "Caladryl Lotion"];

/* products we force to a specific remaining quantity after the sim */
const END_STATE: Record<string, number> = {
  "Dolo 650": 4,         // ~1.7 days of sales left -> CRITICAL stockout
  "Crocin Advance": 6,   // ~3.3 days -> critical
  "Pan 40": 9,           // critical low stock (fast mover)
  "Azithral 500": 8,     // near stockout
  "Augmentin 625": 18,   // low stock
  "Glycomet 500": 14,    // low stock
  "Combiflam": 480,      // healthy
  "Ecosprin 75": 340,    // healthy
};

const FIRST = [
  "Ravi", "Sita", "Arjun", "Kavya", "Rahul", "Meena", "Vikram", "Anita", "Suresh", "Lakshmi",
  "Rohan", "Pooja", "Aakash", "Nisha", "Kiran", "Divya", "Manish", "Geetha", "Farhan", "Shreya",
  "Naveen", "Deepa", "Sandeep", "Radhika", "Imran", "Vanitha", "Harsha", "Ananya", "Manoj", "Tanvi",
  "Prakash", "Sunitha", "Vivek", "Rekha", "Abhishek", "Madhavi", "Rakesh", "Swapna", "Gopal", "Hema",
  "Dinesh", "Sarala", "Karthik", "Bhavana", "Srinivas", "Usha", "Nitin", "Roopa", "Ashok", "Preeti",
  "Yogesh", "Chandra", "Mohan", "Ratna", "Vyshnavi",
];
const LAST = [
  "Sharma", "Iyer", "Reddy", "Patel", "Nair", "Rao", "Gupta", "Das", "Menon", "Khan",
  "Mehta", "Shetty", "Pillai", "Joshi", "Bose", "Choudhury", "Naidu", "Verma", "Bhat", "Saxena",
];

const BRANCHES = [
  { name: "Bannerghatta Road", code: "BGL01" },
  { name: "Jayanagar", code: "JNR02" },
  { name: "Koramangala", code: "KML03" },
];

const VOLUME_FORMS = ["Syrup", "Lotion", "Eye Drops", "Nasal Drops", "Solution"];
const MASS_FORMS = ["Ointment", "Cream", "Gel", "Powder"];

/**
 * Builds the canonical packaging config for a product from its dosage form and
 * pack size. Batch.quantity is stored in the BASE unit (tablet / ml / g).
 */
function unitConfigFor(dosageForm: string | null, pack: string | null) {
  const packNum = parseInt((pack ?? "").split(" ")[0] ?? "", 10);
  const n = Number.isFinite(packNum) && packNum > 0 ? packNum : 1;
  const form = dosageForm ?? "";
  if (VOLUME_FORMS.includes(form)) {
    return {
      baseUnit: "ml",
      baseUnitLabel: "ml",
      saleUnit: "bottle",
      saleUnitFactor: n,
      levels: [{ name: "bottle", factor: n, label: "bottle" }],
    };
  }
  if (MASS_FORMS.includes(form)) {
    return {
      baseUnit: "g",
      baseUnitLabel: "g",
      saleUnit: "pack",
      saleUnitFactor: n,
      levels: [{ name: "pack", factor: n, label: "pack" }],
    };
  }
  const base = form.toLowerCase().includes("capsule") ? "capsule" : "tablet";
  return {
    baseUnit: base,
    baseUnitLabel: base,
    saleUnit: "strip",
    saleUnitFactor: n,
    levels: [
      { name: "box", factor: n * 10, label: "box" },
      { name: "strip", factor: n, label: "strip" },
    ],
  };
}

const PAYMENT_MODES = ["CASH", "UPI", "CARD", "BANK_TRANSFER"] as const;
const TIER_WEIGHT = { A: 6, B: 2.2, C: 0.8, D: 0 } as const;
const TIER_QTY = { A: 350, B: 120, C: 55, D: 170 } as const;

interface Stock {
  productId: string;
  batchId: string;
  branchId: string;
  qty: number;
  expiry: Date;
  purchasePrice: number;
  mrp: number;
  sellingPrice: number;
  supplierId: string;
  batchNumber: string;
}

async function main() {
  console.log("🌱 PharmaSuite seed started");

  /* ---------- wipe existing data ---------- */
  await prisma.paymentRecord.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.alertRead.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.prescription.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.purchaseReceiptItem.deleteMany();
  await prisma.purchaseReceipt.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.inventoryMovement.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.product.deleteMany();
  await prisma.productCategory.deleteMany();
  await prisma.user.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.organization.deleteMany();

  /* ---------- organization & branches ---------- */
  const org = await prisma.organization.create({
    data: {
      name: "PharmaSuite Health Hub",
      code: "PSHH-001",
      gstin: "29AABCP1234F1Z5",
      address: "24/7 Bannerghatta Main Road, Bengaluru, Karnataka 560076",
      currency: "INR",
      timezone: "Asia/Kolkata",
      settings: { lowStockThreshold: 15, safetyStockDays: 3 },
    },
  });

  const trialStartsAt = daysFromNow(-7);
  const trialEndsAt = daysFromNow(7);
  await prisma.subscription.create({
    data: {
      organizationId: org.id,
      tier: "TRIAL_14_DAYS",
      status: "TRIALING",
      billingCycle: "MONTHLY",
      trialStartsAt,
      trialEndsAt,
      currentPeriodStart: trialStartsAt,
      currentPeriodEnd: trialEndsAt,
    },
  });

  const branchRows = [];
  for (const b of BRANCHES) {
    const row = await prisma.branch.create({
      data: {
        organizationId: org.id,
        name: b.name,
        code: b.code,
        phone: `+91 80 ${int(1000, 9999)} ${int(1000, 9999)}`,
        address: "Bengaluru",
        city: "Bengaluru",
        state: "Karnataka",
      },
    });
    branchRows.push(row);
  }

  /* ---------- users ---------- */
  const passwordHash = await bcrypt.hash("Pharma@123", 12);
  const users: Record<string, { id: string }> = {};
  const userDefs: { key: string; fullName: string; email: string; role: Role; branchId: string | null }[] = [
    { key: "superadmin", fullName: "System Admin", email: "superadmin@pharmasuite.example", role: "SUPER_ADMIN", branchId: null as string | null },
    { key: "owner", fullName: "Arun Raghavan", email: "owner@pharmasuite.example", role: "OWNER", branchId: null as string | null },
    { key: "manager", fullName: "Priya Menon", email: "manager@pharmasuite.example", role: "MANAGER", branchId: branchRows[0].id },
    { key: "pharmacist", fullName: "Deepak S", email: "pharmacist@pharmasuite.example", role: "PHARMACIST", branchId: branchRows[0].id },
    { key: "staff1", fullName: "Kavitha R", email: "staff@pharmasuite.example", role: "STAFF", branchId: branchRows[1].id },
    { key: "staff2", fullName: "Manoj Kumar", email: "staff2@pharmasuite.example", role: "STAFF", branchId: branchRows[2].id },
  ];
  for (const u of userDefs) {
    const row = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: u.email,
        fullName: u.fullName,
        phone: `+91 98${int(10000000, 99999999)}`,
        passwordHash,
        role: u.role,
        status: "ACTIVE",
        branchId: u.branchId,
        lastLoginAt: daysFromNow(-1),
      },
    });
    users[u.key] = { id: row.id };
  }

  /* ---------- categories & products ---------- */
  const categories = new Map<string, string>();
  for (const name of CATEGORIES) {
    const c = await prisma.productCategory.create({ data: { organizationId: org.id, name } });
    categories.set(name, c.id);
  }

  const productIds: string[] = [];
  const productTier = new Map<string, "A" | "B" | "C" | "D">();
  const productGst = new Map<string, number>();

  for (let i = 0; i < PRODUCTS.length; i++) {
    const [brand, generic, manufacturer, strength, form, pack, gst, tier] = PRODUCTS[i];
    const p = await prisma.product.create({
      data: {
        organizationId: org.id,
        categoryId: categories.get(CATEGORIES[i % CATEGORIES.length]) ?? null,
        brand,
        genericName: generic,
        manufacturer,
        strength: strength === "—" ? null : strength,
        dosageForm: form === "—" ? null : form,
        packSize: pack === "—" ? null : pack,
        barcode: `8901${String(2000000 + i)}${String(i).padStart(2, "0")}`,
        hsnCode: gst >= 18 ? "30049099" : gst === 5 ? "30049039" : "30049069",
        gstRate: gst,
        prescriptionRequired: !OTC_BRANDS.has(brand),
        isActive: true,
        unitConfig: unitConfigFor(form, pack) as never,
      },
    });
    productIds.push(p.id);
    productTier.set(p.id, tier);
    productGst.set(p.id, gst);
  }

  /* ---------- suppliers ---------- */
  const supplierIds: string[] = [];
  for (const s of SUPPLIERS) {
    const row = await prisma.supplier.create({
      data: {
        organizationId: org.id,
        name: s.name,
        contactPerson: s.person,
        phone: `+91 99${int(10000000, 99999999)}`,
        email: `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.dist@example.in`,
        gstin: `29${Array.from({ length: 14 }, () => int(0, 9)).join("")}`,
        address: "Drugs Wholesale Market, Bengaluru",
        paymentTerms: s.terms,
        leadTimeDays: s.leadTime,
        rating: round2(between(3.5, 4.8)),
      },
    });
    supplierIds.push(row.id);
  }

  /* ---------- customers ---------- */
  const customerIds: string[] = [];
  for (let i = 0; i < 55; i++) {
    const row = await prisma.customer.create({
      data: {
        organizationId: org.id,
        name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
        phone: `+91 9${int(600000000, 999999999)}`,
        address: "Bengaluru",
        notes: i % 11 === 0 ? "Frequent customer" : null,
      },
    });
    customerIds.push(row.id);
  }

  /* ---------- batches (opening stock) ---------- */
  const stockByKey = new Map<string, Stock[]>();
  const stockAll: Stock[] = [];

  const expiryFor = (brand: string, batchIdx: number, branchIdx: number): Date => {
    const showcase = EXPIRY_SHOWCASE[brand];
    if (showcase && showcase[batchIdx] !== undefined) {
      return daysFromNow(showcase[batchIdx]);
    }
    if (EXPIRED_STOCK.includes(brand) && batchIdx === 0) {
      return daysFromNow(-int(10, 70));
    }
    const idx = (PRODUCTS.findIndex(p => p[0] === brand) + branchIdx * 3 + batchIdx * 5) % 10;
    if (idx < 1) return daysFromNow(int(15, 29));   // 0-30 days
    if (idx < 3) return daysFromNow(int(31, 59));   // 31-60
    if (idx < 5) return daysFromNow(int(61, 89));   // 61-90
    if (idx < 7) return daysFromNow(int(91, 179));  // 91-180
    return daysFromNow(int(200, 540));              // healthy
  };

  for (let bIdx = 0; bIdx < productIds.length; bIdx++) {
    const pId = productIds[bIdx];
    const tier = productTier.get(pId)!;
    const brand = PRODUCTS[bIdx][0];
    const branchCount = tier === "D" ? 1 : int(1, 2);
    const branches = [...branchRows].sort(() => rnd() - 0.5).slice(0, branchCount);

    for (const branch of branches) {
      const batchCount = tier === "D" ? 1 : int(1, 3);
      for (let k = 0; k < batchCount; k++) {
        const expiry = expiryFor(brand, k, branchRows.indexOf(branch));
        const baseQty = EXPIRED_STOCK.includes(brand) ? int(10, 30) : Math.max(1, Math.round(TIER_QTY[tier] / batchCount) + int(-20, 40));
        const mrp = round2(int(35, 420));
        const purchasePrice = round2(mrp * between(0.58, 0.68));
        const sellingPrice = round2(mrp * between(0.82, 0.9));
        const supplierId = pick(supplierIds);
        const batch = await prisma.batch.create({
          data: {
            organizationId: org.id,
            branchId: branch.id,
            productId: pId,
            supplierId,
            batchNumber: `BT${int(100000, 999999)}`,
            expiryDate: expiry,
            purchasePrice,
            mrp,
            sellingPrice,
            quantity: baseQty,
            openingQuantity: baseQty,
          },
        });
        const stock: Stock = {
          productId: pId,
          batchId: batch.id,
          branchId: branch.id,
          qty: baseQty,
          expiry,
          purchasePrice,
          mrp,
          sellingPrice,
          supplierId,
          batchNumber: batch.batchNumber,
        };
        stockAll.push(stock);
        const key = `${branch.id}:${pId}`;
        const list = stockByKey.get(key) ?? [];
        list.push(stock);
        stockByKey.set(key, list);

        await prisma.inventoryMovement.create({
          data: {
            organizationId: org.id,
            branchId: branch.id,
            productId: pId,
            batchId: batch.id,
            type: "OPENING_STOCK",
            quantity: baseQty,
            beforeQty: 0,
            afterQty: baseQty,
            unitCost: purchasePrice,
            referenceType: "SEED",
            userId: users.owner.id,
          },
        });
      }
    }
  }

  /* ---------- purchase history + open POs ---------- */
  const purchaseScenario: { brand: string; qty: number; status: string; daysAgo: number }[] = [
    { brand: "Combiflam", qty: 600, status: "RECEIVED", daysAgo: 88 },
    { brand: "Pan 40", qty: 250, status: "RECEIVED", daysAgo: 82 },
    { brand: "Ecosprin 75", qty: 400, status: "COMPLETED", daysAgo: 76 },
    { brand: "Augmentin 625", qty: 220, status: "RECEIVED", daysAgo: 70 },
    { brand: "Glycomet 500", qty: 350, status: "RECEIVED", daysAgo: 63 },
    { brand: "Shelcal 500", qty: 260, status: "COMPLETED", daysAgo: 48 },
    { brand: "Becosules", qty: 300, status: "RECEIVED", daysAgo: 40 },
    { brand: "Telma 40", qty: 200, status: "RECEIVED", daysAgo: 33 },
    { brand: "Amlong 5", qty: 220, status: "RECEIVED", daysAgo: 26 },
    { brand: "Dolo 650", qty: 250, status: "APPROVED", daysAgo: 4 },
    { brand: "Omez 20", qty: 300, status: "DRAFT", daysAgo: 2 },
  ];
  for (let i = 0; i < purchaseScenario.length; i++) {
    const sc = purchaseScenario[i];
    const productIndex = PRODUCTS.findIndex(p => p[0] === sc.brand);
    if (productIndex < 0) continue;
    const productId = productIds[productIndex];
    const branch = branchRows[i % branchRows.length];
    const supplierId = pick(supplierIds);
    const price = round2(between(90, 300));
    const qty = sc.qty;
    const received = sc.status === "RECEIVED" || sc.status === "COMPLETED";
    const purchase = await prisma.purchase.create({
      data: {
        poNumber: `PO-2026-${String(2000 + i)}`,
        organizationId: org.id,
        branchId: branch.id,
        supplierId,
        status: sc.status as never,
        orderDate: daysFromNow(-sc.daysAgo),
        expectedDelivery: daysFromNow(-sc.daysAgo + 4),
        receivedAt: received ? daysFromNow(-sc.daysAgo + 3) : null,
        subtotal: round2(price * qty),
        discount: 0,
        tax: round2(price * qty * 0.12),
        total: round2(price * qty * 1.12),
        createdById: users.manager.id,
        approvedById: sc.status === "APPROVED" || received ? users.owner.id : null,
        items: {
          create: {
            productId,
            batchNumber: `PO${i + 1}-BT`,
            quantity: qty,
            purchasePrice: price,
            mrp: round2(price * 1.5),
            sellingPrice: round2(price * 1.35),
            gstRate: 12,
            discount: 0,
            expiryDate: daysFromNow(int(120, 400)),
            total: round2(price * qty * 1.12),
            receivedQty: received ? qty : 0,
          },
        },
      },
      include: { items: true },
    });
    if (received) {
      await prisma.inventoryMovement.create({
        data: {
          organizationId: org.id,
          branchId: branch.id,
          productId,
          batchId: null,
          type: "PURCHASE",
          quantity: qty,
          beforeQty: 0,
          afterQty: qty,
          unitCost: price,
          referenceType: "PURCHASE",
          referenceId: purchase.id,
          userId: users.manager.id,
        },
      });
      void purchase;
    }
  }

  /* ---------- sales simulation (last 120 days) ---------- */
  let invoiceCounter = 1;
  for (let day = 119; day >= 0; day--) {
    const date = daysFromNow(-day);
    const invoices = int(5, 13);

    for (let v = 0; v < invoices; v++) {
      const branch = pick(branchRows);

      // candidates: products with stock at this branch, weighted by tier
      const candidates: string[] = [];
      for (const [key, list] of stockByKey) {
        if (!key.startsWith(`${branch.id}:`)) continue;
        const totalQty = list.reduce((s, st) => s + st.qty, 0);
        if (totalQty <= 0) continue;
        const pId = key.slice(branch.id.length + 1);
        const tier = productTier.get(pId) ?? "B";
        if (tier === "D") continue;
        const w = Math.round(TIER_WEIGHT[tier] * 10);
        for (let c = 0; c < w; c++) candidates.push(pId);
      }
      if (!candidates.length) continue;

      const itemCount = int(1, 5);
      const chosen = new Set<string>();
      for (let i = 0; i < itemCount && candidates.length; i++) {
        chosen.add(pick(candidates));
      }

      let subtotal = 0;
      let tax = 0;
      let saleCreated = false;
      let saleIdLocal = "";

      for (const pId of chosen) {
        const tier = productTier.get(pId)!;
        const maxQty = tier === "A" ? int(2, 12) : tier === "B" ? int(1, 6) : int(1, 3);
        let qty = int(1, maxQty);

        const list = [...(stockByKey.get(`${branch.id}:${pId}`) ?? []).filter(st => st.qty > 0)].sort(
          (a, b) => a.expiry.getTime() - b.expiry.getTime(),
        );
        const allocations: { stock: Stock; qty: number }[] = [];
        let remaining = qty;
        for (const st of list) {
          if (remaining <= 0) break;
          const take = Math.min(st.qty, remaining);
          allocations.push({ stock: st, qty: take });
          remaining -= take;
        }
        if (remaining > 0) {
          qty -= remaining;
          if (qty <= 0) continue;
        }

        for (const { stock: st, qty: take } of allocations) {
          const unitPrice = st.sellingPrice;
          const gGst = productGst.get(pId) ?? 12;
          subtotal += unitPrice * take;
          tax += (unitPrice * take * gGst) / 100;

          if (!saleCreated) {
            const sale = await prisma.sale.create({
              data: {
                invoiceNo: `INV-2026-${String(invoiceCounter++).padStart(4, "0")}`,
                organizationId: org.id,
                branchId: branch.id,
                customerId: customerIds[int(0, customerIds.length - 1)],
                status: "PAID",
                paymentMode: pick(PAYMENT_MODES),
                subtotal: 0,
                discount: 0,
                tax: 0,
                total: 0,
                createdAt: new Date(date.getTime() + int(9, 20) * 3_600_000 + int(0, 59) * 60_000),
                createdById: pick([users.pharmacist.id, users.staff1.id, users.staff2.id]),
              },
            });
            saleIdLocal = sale.id;
            saleCreated = true;
          }

          st.qty -= take;
          await prisma.batch.update({ where: { id: st.batchId }, data: { quantity: st.qty } });
          await prisma.saleItem.create({
            data: {
              saleId: saleIdLocal,
              productId: pId,
              batchId: st.batchId,
              quantity: take,
              unitPrice,
              unitCost: st.purchasePrice,
              gstRate: gGst,
              total: round2(unitPrice * take),
            },
          });
        }
      }

      if (saleCreated) {
        await prisma.sale.update({
          where: { id: saleIdLocal },
          data: { subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax) },
        });
      }
    }
  }

  /* ---------- force explicit end-states for showcase products ---------- */
  // Products are randomly assigned to branches, so apply the end-state to
  // every branch that actually stocks the product.
  const setRemaining = async (brand: string, targetQty: number) => {
    const productIndex = PRODUCTS.findIndex(p => p[0] === brand);
    if (productIndex < 0) return;
    const pId = productIds[productIndex];
    for (const branch of branchRows) {
      const key = `${branch.id}:${pId}`;
      const batches = stockByKey.get(key);
      if (!batches || !batches.length) continue;
      batches.sort((a, b) => a.expiry.getTime() - b.expiry.getTime());
      let remaining = targetQty;
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        const assign = i === batches.length - 1 ? remaining : Math.min(remaining, Math.ceil(remaining / (batches.length - i)));
        await prisma.batch.update({ where: { id: b.batchId }, data: { quantity: assign } });
        b.qty = assign;
        remaining -= assign;
      }
    }
  };

  for (const [brand, target] of Object.entries(END_STATE)) {
    await setRemaining(brand, target);
  }

  // Keep explicitly-expired stock on the shelf so the expiry engine reports it.
  const keepExpired = async (brand: string, target: number) => {
    const productIndex = PRODUCTS.findIndex(p => p[0] === brand);
    if (productIndex < 0) return;
    const pId = productIds[productIndex];
    const now = Date.now();
    for (const list of stockByKey.values()) {
      for (const st of list) {
        if (st.productId !== pId) continue;
        const q = st.expiry.getTime() < now ? target : 0;
        await prisma.batch.update({ where: { id: st.batchId }, data: { quantity: q } });
        st.qty = q;
      }
    }
  };
  await keepExpired("Cremaffin Plus", 14);
  await keepExpired("Caladryl Lotion", 9);

  /* ---------- alerts snapshot ---------- */
  await prisma.alert.createMany({
    data: [
      {
        organizationId: org.id,
        type: "STOCKOUT_RISK", severity: "CRITICAL",
        title: "Dolo 650 may stock out",
        message: "Dolo 650 has 4 units left and is selling ~2.3/day. Estimated stockout in ~1.7 days.",
        entityType: "Product", status: "ACTIVE", metadata: {},
      },
      {
        organizationId: org.id,
        type: "LOW_STOCK", severity: "HIGH",
        title: "Several products are low on stock",
        message: "Crocin Advance, Pan 40, Augmentin 625 and more are at or below reorder level.",
        entityType: "Product", status: "ACTIVE", metadata: {},
      },
      {
        organizationId: org.id,
        type: "EXPIRY", severity: "CRITICAL",
        title: "Inventory expiring within 30 days",
        message: "Shelcal 500, Rantac 150, Omez 20 and Vitcofol inventory is expiring within 30 days.",
        entityType: "Batch", status: "ACTIVE", metadata: { bucket: "0-30" },
      },
      {
        organizationId: org.id,
        type: "EXPIRY", severity: "CRITICAL",
        title: "Expired stock on shelf",
        message: "Cremaffin Plus and Caladryl Lotion batches have expired.",
        entityType: "Batch", status: "ACTIVE", metadata: { bucket: "EXPIRED" },
      },
      {
        organizationId: org.id,
        type: "DEAD_STOCK", severity: "HIGH",
        title: "Capital trapped in dead stock",
        message: "₹1.2L+ of inventory hasn't moved in 60+ days (Neurobion, A to Z NS, Liv-52 and more).",
        entityType: "Product", status: "ACTIVE", metadata: {},
      },
      {
        organizationId: org.id,
        type: "PENDING_PURCHASE", severity: "MEDIUM",
        title: "Approved POs awaiting receipt",
        message: "An approved purchase order for Dolo 650 has not been received yet.",
        entityType: "Purchase", status: "ACTIVE", metadata: {},
      },
    ],
  });

  /* ---------- prescriptions (metadata only) ---------- */
  for (let i = 0; i < 6; i++) {
    await prisma.prescription.create({
      data: {
        organizationId: org.id,
        branchId: pick(branchRows).id,
        customerId: customerIds[int(0, customerIds.length - 1)],
        doctorName: pick(["Dr. Satish Rao", "Dr. Meera Krishnan", "Dr. Anand Hegde"]),
        prescriptionDate: daysFromNow(-int(1, 90)),
        notes: "Seed demo prescription — no file attached.",
        fileName: "handwritten-rx.jpg",
        filePath: "tmp/seed-no-file.jpg",
        mimeType: "image/jpeg",
        fileSize: 0,
        uploadedById: users.pharmacist.id,
      },
    });
  }

  /* ---------- audit logs ---------- */
  await prisma.auditLog.createMany({
    data: [
      { organizationId: org.id, userId: users.owner.id, action: "LOGIN", entityType: "Auth", metadata: {} },
      { organizationId: org.id, userId: users.manager.id, action: "LOGIN", entityType: "Auth", metadata: {} },
      { organizationId: org.id, userId: users.owner.id, action: "SETTINGS_CHANGED", entityType: "Organization", entityId: org.id, metadata: { key: "lowStockThreshold" } },
      { organizationId: org.id, userId: users.owner.id, action: "USER_CREATED", entityType: "User", metadata: { count: userDefs.length } },
    ],
  });

  console.log(`  Org: ${org.name}`);
  console.log(`  Branches: ${branchRows.length} | Products: ${productIds.length} | Suppliers: ${supplierIds.length} | Customers: ${customerIds.length}`);
  console.log(`  Batches: ${stockAll.length} | Sales generated over 120 days`);
  console.log("  Users: superadmin / owner / manager / pharmacist / staff / staff2 — password: Pharma@123");
  console.log("✅ Seed complete");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });