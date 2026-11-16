// Default chart of accounts for a Philippine company reporting under PFRS (the PH adoption of IFRS)
// or PFRS for SMEs. ifrsGroup is the line item each account rolls up to on the financial statements.
import type { AccountType } from "@prisma/client";

export type TemplateAccount = {
  code: string;
  name: string;
  type: AccountType;
  ifrsGroup: string;
  isCurrent?: boolean;
  header?: boolean; // non-postable summary account
  parent?: string;  // parent code
  systemRole?: string;
};

const A = "ASSET", L = "LIABILITY", E = "EQUITY", I = "INCOME", X = "EXPENSE";

export const PH_IFRS_TEMPLATE: TemplateAccount[] = [
  // ---- ASSETS ----
  { code: "1000", name: "Current Assets", type: A, ifrsGroup: "Current assets", isCurrent: true, header: true },
  { code: "1010", name: "Cash on Hand", type: A, ifrsGroup: "Cash and cash equivalents", isCurrent: true, parent: "1000", systemRole: "CASH_ON_HAND" },
  { code: "1015", name: "Petty Cash Fund", type: A, ifrsGroup: "Cash and cash equivalents", isCurrent: true, parent: "1000", systemRole: "PETTY_CASH_FUND" },
  { code: "1020", name: "Cash in Bank - Current Account", type: A, ifrsGroup: "Cash and cash equivalents", isCurrent: true, parent: "1000" },
  { code: "1025", name: "Cash in Bank - Savings Account", type: A, ifrsGroup: "Cash and cash equivalents", isCurrent: true, parent: "1000" },
  { code: "1030", name: "Cash in GCash Wallet (Corporate)", type: A, ifrsGroup: "Cash and cash equivalents", isCurrent: true, parent: "1000", systemRole: "GCASH_WALLET" },
  { code: "1035", name: "Cash in Maya Wallet (Corporate)", type: A, ifrsGroup: "Cash and cash equivalents", isCurrent: true, parent: "1000", systemRole: "MAYA_WALLET" },
  { code: "1100", name: "Accounts Receivable - Trade", type: A, ifrsGroup: "Trade and other receivables", isCurrent: true, parent: "1000", systemRole: "AR_CONTROL" },
  { code: "1105", name: "Allowance for Expected Credit Losses", type: A, ifrsGroup: "Trade and other receivables", isCurrent: true, parent: "1000" },
  { code: "1110", name: "Advances to Employees", type: A, ifrsGroup: "Trade and other receivables", isCurrent: true, parent: "1000", systemRole: "EMPLOYEE_ADVANCES" },
  { code: "1115", name: "Advances to Officers / Partners", type: A, ifrsGroup: "Trade and other receivables", isCurrent: true, parent: "1000" },
  { code: "1120", name: "Other Receivables", type: A, ifrsGroup: "Trade and other receivables", isCurrent: true, parent: "1000" },
  { code: "1200", name: "Merchandise Inventory", type: A, ifrsGroup: "Inventories", isCurrent: true, parent: "1000", systemRole: "INVENTORY" },
  { code: "1205", name: "Inventory in Transit", type: A, ifrsGroup: "Inventories", isCurrent: true, parent: "1000", systemRole: "INVENTORY_IN_TRANSIT" },
  { code: "1300", name: "Prepaid Expenses", type: A, ifrsGroup: "Prepayments and other current assets", isCurrent: true, parent: "1000" },
  { code: "1310", name: "Input VAT", type: A, ifrsGroup: "Prepayments and other current assets", isCurrent: true, parent: "1000", systemRole: "INPUT_VAT" },
  { code: "1315", name: "Deferred Input VAT (Capital Goods > P1M)", type: A, ifrsGroup: "Prepayments and other current assets", isCurrent: true, parent: "1000" },
  { code: "1320", name: "Creditable Withholding Tax (BIR 2307)", type: A, ifrsGroup: "Prepayments and other current assets", isCurrent: true, parent: "1000", systemRole: "CWT_RECEIVABLE" },
  { code: "1325", name: "Prepaid Income Tax", type: A, ifrsGroup: "Prepayments and other current assets", isCurrent: true, parent: "1000" },

  { code: "1500", name: "Non-current Assets", type: A, ifrsGroup: "Non-current assets", isCurrent: false, header: true },
  { code: "1510", name: "Land", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1520", name: "Building", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1525", name: "Accumulated Depreciation - Building", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1530", name: "Office Equipment", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1535", name: "Accumulated Depreciation - Office Equipment", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1540", name: "Transportation Equipment", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1545", name: "Accumulated Depreciation - Transportation Equipment", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1550", name: "Furniture and Fixtures", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1555", name: "Accumulated Depreciation - Furniture and Fixtures", type: A, ifrsGroup: "Property, plant and equipment", isCurrent: false, parent: "1500" },
  { code: "1600", name: "Right-of-Use Asset (PFRS 16)", type: A, ifrsGroup: "Right-of-use assets", isCurrent: false, parent: "1500" },
  { code: "1605", name: "Accumulated Depreciation - Right-of-Use Asset", type: A, ifrsGroup: "Right-of-use assets", isCurrent: false, parent: "1500" },
  { code: "1700", name: "Intangible Assets - Software", type: A, ifrsGroup: "Intangible assets", isCurrent: false, parent: "1500" },
  { code: "1800", name: "Deferred Tax Asset", type: A, ifrsGroup: "Deferred tax assets", isCurrent: false, parent: "1500" },
  { code: "1900", name: "Security Deposits", type: A, ifrsGroup: "Other non-current assets", isCurrent: false, parent: "1500" },

  // ---- LIABILITIES ----
  { code: "2000", name: "Current Liabilities", type: L, ifrsGroup: "Current liabilities", isCurrent: true, header: true },
  { code: "2010", name: "Accounts Payable - Trade", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "AP_CONTROL" },
  { code: "2012", name: "Goods Received Not Yet Invoiced", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "GRNI" },
  { code: "2015", name: "Corporate Credit Card Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "CORPORATE_CARD" },
  { code: "2018", name: "Employee Reimbursements Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "EMPLOYEE_REIMB_PAYABLE" },
  { code: "2020", name: "Accrued Expenses", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { code: "2030", name: "Output VAT", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "OUTPUT_VAT" },
  { code: "2035", name: "VAT Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "VAT_PAYABLE" },
  { code: "2040", name: "Withholding Tax Payable - Compensation (1601-C)", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "WTC_PAYABLE" },
  { code: "2045", name: "Withholding Tax Payable - Expanded (1601-EQ / 0619-E)", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "EWT_PAYABLE" },
  { code: "2050", name: "SSS Contributions Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "SSS_PAYABLE" },
  { code: "2055", name: "PhilHealth Contributions Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "PHIC_PAYABLE" },
  { code: "2060", name: "Pag-IBIG (HDMF) Contributions Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "HDMF_PAYABLE" },
  { code: "2065", name: "SSS / Pag-IBIG Loans Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { code: "2070", name: "Salaries and Wages Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000", systemRole: "SALARIES_PAYABLE" },
  { code: "2075", name: "13th Month Pay Payable", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { code: "2080", name: "Income Tax Payable", type: L, ifrsGroup: "Income tax payable", isCurrent: true, parent: "2000", systemRole: "INCOME_TAX_PAYABLE" },
  { code: "2090", name: "Advances from Customers", type: L, ifrsGroup: "Contract liabilities", isCurrent: true, parent: "2000" },
  { code: "2095", name: "Loans Payable - Current Portion", type: L, ifrsGroup: "Loans and borrowings", isCurrent: true, parent: "2000" },
  { code: "2098", name: "Lease Liability - Current Portion", type: L, ifrsGroup: "Lease liabilities", isCurrent: true, parent: "2000" },
  { code: "2099", name: "Due to Officers / Partners", type: L, ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },

  { code: "2500", name: "Non-current Liabilities", type: L, ifrsGroup: "Non-current liabilities", isCurrent: false, header: true },
  { code: "2510", name: "Loans Payable - Non-current", type: L, ifrsGroup: "Loans and borrowings", isCurrent: false, parent: "2500" },
  { code: "2520", name: "Lease Liability - Non-current", type: L, ifrsGroup: "Lease liabilities", isCurrent: false, parent: "2500" },
  { code: "2530", name: "Retirement Benefit Obligation (RA 7641)", type: L, ifrsGroup: "Retirement benefit obligation", isCurrent: false, parent: "2500" },
  { code: "2540", name: "Deferred Tax Liability", type: L, ifrsGroup: "Deferred tax liabilities", isCurrent: false, parent: "2500" },

  // ---- EQUITY ----
  { code: "3000", name: "Equity", type: E, ifrsGroup: "Equity", header: true },
  { code: "3010", name: "Share Capital", type: E, ifrsGroup: "Share capital", parent: "3000" },
  { code: "3020", name: "Additional Paid-in Capital", type: E, ifrsGroup: "Share premium", parent: "3000" },
  { code: "3030", name: "Partners' / Owner's Capital", type: E, ifrsGroup: "Share capital", parent: "3000" },
  { code: "3040", name: "Owner's / Partners' Drawings", type: E, ifrsGroup: "Share capital", parent: "3000" },
  { code: "3100", name: "Retained Earnings", type: E, ifrsGroup: "Retained earnings", parent: "3000", systemRole: "RETAINED_EARNINGS" },
  { code: "3200", name: "Remeasurement of Retirement Benefits (OCI)", type: E, ifrsGroup: "Other comprehensive income reserve", parent: "3000" },

  // ---- INCOME ----
  { code: "4000", name: "Revenue", type: I, ifrsGroup: "Revenue", header: true },
  { code: "4010", name: "Sales - Goods", type: I, ifrsGroup: "Revenue", parent: "4000", systemRole: "SALES" },
  { code: "4020", name: "Service Income", type: I, ifrsGroup: "Revenue", parent: "4000", systemRole: "SERVICE_INCOME" },
  { code: "4030", name: "Sales Returns and Allowances", type: I, ifrsGroup: "Revenue", parent: "4000" },
  { code: "4040", name: "Sales Discounts", type: I, ifrsGroup: "Revenue", parent: "4000" },

  { code: "5000", name: "Cost of Sales", type: X, ifrsGroup: "Cost of sales", header: true },
  { code: "5010", name: "Cost of Goods Sold", type: X, ifrsGroup: "Cost of sales", parent: "5000", systemRole: "COGS" },
  { code: "5020", name: "Cost of Services", type: X, ifrsGroup: "Cost of sales", parent: "5000" },

  // ---- OPERATING EXPENSES ----
  { code: "6000", name: "Operating Expenses", type: X, ifrsGroup: "Operating expenses", header: true },
  { code: "6010", name: "Salaries and Wages", type: X, ifrsGroup: "Employee benefits expense", parent: "6000", systemRole: "SALARIES_EXPENSE" },
  { code: "6015", name: "13th Month Pay and Other Benefits", type: X, ifrsGroup: "Employee benefits expense", parent: "6000" },
  { code: "6020", name: "SSS, PhilHealth and Pag-IBIG Contributions (Employer)", type: X, ifrsGroup: "Employee benefits expense", parent: "6000", systemRole: "GOVT_CONTRIB_EXPENSE" },
  { code: "6025", name: "Retirement Benefit Expense", type: X, ifrsGroup: "Employee benefits expense", parent: "6000" },
  { code: "6030", name: "Rent Expense", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6040", name: "Utilities - Electricity and Water", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6045", name: "Communication - Telephone and Internet", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6050", name: "Transportation and Travel", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6052", name: "Delivery and Courier Expense", type: X, ifrsGroup: "Operating expenses", parent: "6000", systemRole: "DELIVERY_EXPENSE" },
  { code: "6055", name: "Representation and Entertainment", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6060", name: "Office Supplies", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6065", name: "Repairs and Maintenance", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6070", name: "Professional Fees", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6075", name: "Taxes and Licenses", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6080", name: "Insurance", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6085", name: "Advertising and Promotions", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6090", name: "Depreciation Expense", type: X, ifrsGroup: "Depreciation and amortization", parent: "6000" },
  { code: "6095", name: "Amortization Expense", type: X, ifrsGroup: "Depreciation and amortization", parent: "6000" },
  { code: "6100", name: "Expected Credit Losses (Bad Debts)", type: X, ifrsGroup: "Impairment losses on receivables", parent: "6000" },
  { code: "6110", name: "Fuel and Oil", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6120", name: "Meals and Allowances", type: X, ifrsGroup: "Operating expenses", parent: "6000" },
  { code: "6190", name: "Miscellaneous Expense", type: X, ifrsGroup: "Operating expenses", parent: "6000" },

  // ---- OTHER INCOME / EXPENSE ----
  { code: "7000", name: "Other Income and Expenses", type: I, ifrsGroup: "Other income", header: true },
  { code: "7010", name: "Interest Income", type: I, ifrsGroup: "Finance income", parent: "7000" },
  { code: "7020", name: "Foreign Exchange Gain - Realized", type: I, ifrsGroup: "Other income", parent: "7000", systemRole: "FX_GAIN" },
  { code: "7025", name: "Unrealized Foreign Exchange Gain", type: I, ifrsGroup: "Other income", parent: "7000", systemRole: "UNREALIZED_FX_GAIN" },
  { code: "7030", name: "Gain on Sale of Assets", type: I, ifrsGroup: "Other income", parent: "7000" },
  { code: "7040", name: "Miscellaneous Income", type: I, ifrsGroup: "Other income", parent: "7000" },
  { code: "7510", name: "Interest Expense", type: X, ifrsGroup: "Finance costs", parent: "7000" },
  { code: "7520", name: "Bank Charges", type: X, ifrsGroup: "Finance costs", parent: "7000", systemRole: "BANK_CHARGES" },
  { code: "7530", name: "Foreign Exchange Loss - Realized", type: X, ifrsGroup: "Other expenses", parent: "7000", systemRole: "FX_LOSS" },
  { code: "7535", name: "Unrealized Foreign Exchange Loss", type: X, ifrsGroup: "Other expenses", parent: "7000", systemRole: "UNREALIZED_FX_LOSS" },
  { code: "7540", name: "Final Tax on Interest Income", type: X, ifrsGroup: "Other expenses", parent: "7000" },

  // ---- INCOME TAX ----
  { code: "8000", name: "Income Tax Expense", type: X, ifrsGroup: "Income tax expense", header: true },
  { code: "8010", name: "Income Tax Expense - Current", type: X, ifrsGroup: "Income tax expense", parent: "8000", systemRole: "INCOME_TAX_EXPENSE" },
  { code: "8020", name: "Income Tax Expense - Deferred", type: X, ifrsGroup: "Income tax expense", parent: "8000" },
] as TemplateAccount[];

// Contra accounts carry the opposite normal balance of their type.
const CONTRA_CODES = new Set(["1105", "1525", "1535", "1545", "1555", "1605", "3040", "4030", "4040"]);

export function normalBalanceFor(t: TemplateAccount): "DEBIT" | "CREDIT" {
  const base = t.type === "ASSET" || t.type === "EXPENSE" ? "DEBIT" : "CREDIT";
  if (!CONTRA_CODES.has(t.code)) return base;
  return base === "DEBIT" ? "CREDIT" : "DEBIT";
}
