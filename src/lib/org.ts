import { prisma } from "./db";
import { seedChartOfAccounts } from "./ledger/service";

// Common BIR tax codes. Rates and ATCs follow current BIR rules (TRAIN / CREATE / RR 11-2018 as amended);
// review against the latest revenue regulations before filing.
export const PH_TAX_CODES = [
  { code: "VAT12-OUT", name: "Output VAT 12%", taxType: "VAT_OUTPUT", rate: 12, atcCode: null, accountCode: "2030" },
  { code: "VAT12-IN", name: "Input VAT 12%", taxType: "VAT_INPUT", rate: 12, atcCode: null, accountCode: "1310" },
  { code: "VAT0", name: "Zero-rated sales", taxType: "VAT_OUTPUT", rate: 0, atcCode: null, accountCode: "2030" },
  { code: "VATEX", name: "VAT-exempt sales", taxType: "VAT_OUTPUT", rate: 0, atcCode: null, accountCode: null },
  { code: "WC158", name: "EWT 1% - purchase of goods from regular suppliers (corporate)", taxType: "EWT", rate: 1, atcCode: "WC158", accountCode: "2045" },
  { code: "WI158", name: "EWT 1% - purchase of goods from regular suppliers (individual)", taxType: "EWT", rate: 1, atcCode: "WI158", accountCode: "2045" },
  { code: "WC160", name: "EWT 2% - purchase of services from regular suppliers (corporate)", taxType: "EWT", rate: 2, atcCode: "WC160", accountCode: "2045" },
  { code: "WI160", name: "EWT 2% - purchase of services from regular suppliers (individual)", taxType: "EWT", rate: 2, atcCode: "WI160", accountCode: "2045" },
  { code: "WC100", name: "EWT 5% - rentals (corporate lessor)", taxType: "EWT", rate: 5, atcCode: "WC100", accountCode: "2045" },
  { code: "WI100", name: "EWT 5% - rentals (individual lessor)", taxType: "EWT", rate: 5, atcCode: "WI100", accountCode: "2045" },
  { code: "WC010", name: "EWT 10% - professional fees (corporate, gross income <= P720k)", taxType: "EWT", rate: 10, atcCode: "WC010", accountCode: "2045" },
  { code: "WI010", name: "EWT 5% - professional fees (individual, gross <= P3M with sworn declaration)", taxType: "EWT", rate: 5, atcCode: "WI010", accountCode: "2045" },
  { code: "WI011", name: "EWT 10% - professional fees (individual, gross > P3M)", taxType: "EWT", rate: 10, atcCode: "WI011", accountCode: "2045" },
  { code: "WC011", name: "EWT 15% - professional fees (corporate, gross income > P720k)", taxType: "EWT", rate: 15, atcCode: "WC011", accountCode: "2045" },
  { code: "FWT20-INT", name: "Final tax 20% - interest on bank deposits", taxType: "FWT", rate: 20, atcCode: "WC180", accountCode: "7540" },
  { code: "FWT10-DIV", name: "Final tax 10% - cash dividends to individuals", taxType: "FWT", rate: 10, atcCode: "WI202", accountCode: null },
  { code: "PT3", name: "Percentage tax 3% (non-VAT, Sec. 116)", taxType: "PERCENTAGE", rate: 3, atcCode: "PT010", accountCode: null },
];

/** Create a company with its owner, default PH/IFRS chart of accounts and PHP currency. */
// Starter asset categories (edit under Fixed Assets → Asset Categories). Useful lives are common PH
// practice for book purposes; set them to your own estimates under PAS 16.
export const DEFAULT_ASSET_CATEGORIES = [
  { code: "LAND", name: "Land", prefix: "LND", assetAccountCode: "1510", accumDepAccountCode: null, depExpenseAccountCode: null, usefulLifeMonths: 1, depreciationMethod: "NONE" },
  { code: "BLDG", name: "Building", prefix: "BLD", assetAccountCode: "1520", accumDepAccountCode: "1525", depExpenseAccountCode: "6090", usefulLifeMonths: 240, depreciationMethod: "STRAIGHT_LINE" },
  { code: "IT", name: "IT equipment", prefix: "IT", assetAccountCode: "1530", accumDepAccountCode: "1535", depExpenseAccountCode: "6090", usefulLifeMonths: 36, depreciationMethod: "STRAIGHT_LINE" },
  { code: "OFFEQ", name: "Office equipment", prefix: "OE", assetAccountCode: "1530", accumDepAccountCode: "1535", depExpenseAccountCode: "6090", usefulLifeMonths: 60, depreciationMethod: "STRAIGHT_LINE" },
  { code: "VEH", name: "Vehicles", prefix: "VEH", assetAccountCode: "1540", accumDepAccountCode: "1545", depExpenseAccountCode: "6090", usefulLifeMonths: 60, depreciationMethod: "STRAIGHT_LINE" },
  { code: "FURN", name: "Furniture and fixtures", prefix: "FF", assetAccountCode: "1550", accumDepAccountCode: "1555", depExpenseAccountCode: "6090", usefulLifeMonths: 60, depreciationMethod: "STRAIGHT_LINE" },
];

export async function provisionOrganization(input: { name: string; tin?: string | null; ownerUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: input.name.trim(), tin: input.tin?.trim() || null } });
    await tx.membership.create({ data: { userId: input.ownerUserId, organizationId: org.id, role: "OWNER" } });
    await seedChartOfAccounts(tx, org.id);
    await tx.taxCode.createMany({ data: PH_TAX_CODES.map((t) => ({ ...t, organizationId: org.id })) });
    await tx.currency.create({ data: { organizationId: org.id, code: "PHP", name: "Philippine Peso", symbol: "₱", rateToBase: 1 } });
    await tx.assetCategory.createMany({ data: DEFAULT_ASSET_CATEGORIES.map((c) => ({ ...c, organizationId: org.id })) });
    return org;
  }, { timeout: 30_000 });
}
