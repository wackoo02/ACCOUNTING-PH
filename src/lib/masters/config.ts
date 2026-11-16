// One definition per master list drives: the Excel template, the bulk upload
// validator, the list screen, and the add/edit form. Add a column here and it
// shows up everywhere.

export type FieldType = "text" | "number" | "int" | "bool" | "date" | "enum";

export type Field = {
  key: string;
  header: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  example?: string | number | boolean;
  help?: string;
  list?: boolean; // show in list table
};

export type MasterKind = "accounts" | "dimensions" | "taxes" | "banks" | "products" | "employees" | "vendors" | "customers" | "currencies" | "assets";

export type MasterDef = {
  kind: MasterKind;
  title: string;
  singular: string;
  model: "account" | "dimensionValue" | "taxCode" | "bankAccount" | "product" | "employee" | "vendor" | "customer" | "currency" | "fixedAsset";
  fields: Field[];
};

const active: Field = { key: "isActive", header: "Active", type: "bool", example: true, list: true, help: "TRUE or FALSE. Default TRUE." };

export const MASTERS: Record<MasterKind, MasterDef> = {
  accounts: {
    kind: "accounts", title: "Chart of Accounts", singular: "Account", model: "account",
    fields: [
      { key: "code", header: "Account Code", type: "text", required: true, example: "6130", list: true },
      { key: "name", header: "Account Name", type: "text", required: true, example: "Seminars and Trainings", list: true },
      { key: "type", header: "Type", type: "enum", required: true, options: ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"], example: "EXPENSE", list: true },
      { key: "ifrsGroup", header: "IFRS Line Item", type: "text", required: true, example: "Operating expenses", list: true, help: "Line on the financial statements, e.g. Cash and cash equivalents, Trade and other payables." },
      { key: "isCurrent", header: "Current (Assets/Liabilities)", type: "bool", example: "", help: "TRUE = current, FALSE = non-current. Leave blank for equity, income, expense." },
      { key: "normalBalance", header: "Normal Balance", type: "enum", options: ["DEBIT", "CREDIT"], example: "DEBIT", help: "Leave blank to use the usual side for the type." },
      { key: "parentCode", header: "Parent Account Code", type: "text", example: "6000", help: "Header account this rolls up to." },
      { key: "isPostable", header: "Postable", type: "bool", example: true, help: "FALSE for header/summary accounts." },
      { key: "allowManualPosting", header: "Allow Manual Journals", type: "bool", example: true, help: "FALSE = only sub-ledger modules (AR, AP, payroll, bank) may post here." },
      { key: "currencyCode", header: "Account Currency", type: "text", example: "", help: "Only for foreign-currency accounts, e.g. USD for a dollar bank account. Leave blank otherwise." },
      { key: "description", header: "Description", type: "text", example: "" },
      active,
    ],
  },
  dimensions: {
    kind: "dimensions", title: "Dimensions", singular: "Dimension value", model: "dimensionValue",
    fields: [
      { key: "type", header: "Dimension", type: "enum", required: true, options: ["DEPARTMENT", "BRANCH", "BUSINESS_UNIT", "PROJECT", "COST_CENTER", "PROFIT_CENTER", "LOCATION", "PRODUCT_LINE", "DIVISION"], example: "DEPARTMENT", list: true },
      { key: "code", header: "Code", type: "text", required: true, example: "FIN", list: true },
      { key: "name", header: "Name", type: "text", required: true, example: "Finance and Accounting", list: true },
      { key: "parentCode", header: "Parent Code", type: "text", example: "", list: true, help: "Code of the parent value of the same dimension, for hierarchies." },
      { key: "manager", header: "Manager / Head", type: "text", example: "Maria Santos", list: true },
      active,
    ],
  },
  taxes: {
    kind: "taxes", title: "Tax Codes (VAT, EWT, FWT)", singular: "Tax code", model: "taxCode",
    fields: [
      { key: "code", header: "Tax Code", type: "text", required: true, example: "WC158", list: true },
      { key: "name", header: "Description", type: "text", required: true, example: "EWT 1% - goods from regular suppliers (TWA)", list: true },
      { key: "taxType", header: "Tax Type", type: "enum", required: true, options: ["VAT_OUTPUT", "VAT_INPUT", "EWT", "FWT", "PERCENTAGE"], example: "EWT", list: true },
      { key: "rate", header: "Rate %", type: "number", required: true, example: 1, list: true },
      { key: "atcCode", header: "BIR ATC", type: "text", example: "WC158", list: true },
      { key: "accountCode", header: "GL Account Code", type: "text", example: "2045", list: true },
      { key: "description", header: "Notes", type: "text", example: "" },
      active,
    ],
  },
  banks: {
    kind: "banks", title: "Bank and Cash Accounts", singular: "Bank / cash account", model: "bankAccount",
    fields: [
      { key: "code", header: "Code", type: "text", required: true, example: "BDO-CA", list: true, help: "Short code, e.g. BDO-CA, BPI-SA, PCF-ADMIN." },
      { key: "name", header: "Name", type: "text", required: true, example: "BDO Current Account - Makati", list: true },
      { key: "kind", header: "Kind", type: "enum", required: true, options: ["CURRENT", "SAVINGS", "PETTY_CASH", "CASH_ON_HAND", "EWALLET", "CREDIT_CARD"], example: "CURRENT", list: true, help: "CURRENT/SAVINGS = bank (reconciled against statements; debit cards draw on these), PETTY_CASH = imprest fund, CASH_ON_HAND = undeposited collections, EWALLET = corporate GCash / Maya (put GCash or Maya in the name), CREDIT_CARD = corporate credit card (GL account 2015 Corporate Credit Card Payable)." },
      { key: "glAccountCode", header: "GL Account Code", type: "text", required: true, example: "1020", list: true, help: "The cash account in the chart of accounts (Cash and cash equivalents). Each bank/cash account needs its own GL account." },
      { key: "bankName", header: "Bank", type: "text", example: "BDO Unibank", list: true },
      { key: "branchName", header: "Bank Branch", type: "text", example: "Makati Ayala" },
      { key: "accountNumber", header: "Account Number", type: "text", example: "0012-3456-7890", list: true },
      { key: "currencyCode", header: "Currency", type: "text", example: "PHP", list: true, help: "Must match the GL account's currency. Default PHP." },
      { key: "nextCheckNo", header: "Next Check No.", type: "int", example: 1001, help: "Current accounts: the next check number in the checkbook. Check vouchers are numbered from here." },
      { key: "custodian", header: "Custodian", type: "text", example: "Maria Santos", help: "Petty cash: the person accountable for the fund." },
      { key: "fundLimit", header: "Fund Amount (Imprest)", type: "number", example: 10000, help: "Petty cash: the fixed fund amount." },
      active,
    ],
  },
  products: {
    kind: "products", title: "Products and Prices", singular: "Product", model: "product",
    fields: [
      { key: "code", header: "Product Code", type: "text", required: true, example: "P-0001", list: true },
      { key: "name", header: "Product / Service Name", type: "text", required: true, example: "Bond Paper A4 (ream)", list: true },
      { key: "kind", header: "Kind", type: "enum", options: ["GOODS", "SERVICE"], example: "GOODS", list: true },
      { key: "unit", header: "Unit", type: "text", example: "ream", list: true },
      { key: "sellingPrice", header: "Selling Price", type: "number", example: 250, list: true },
      { key: "purchaseCost", header: "Purchase Cost", type: "number", example: 190, list: true },
      { key: "currencyCode", header: "Currency", type: "text", example: "PHP", list: true },
      { key: "vatType", header: "VAT Type", type: "enum", options: ["VATABLE", "ZERO_RATED", "EXEMPT"], example: "VATABLE", list: true },
      { key: "salesAccountCode", header: "Sales Account Code", type: "text", example: "4010" },
      { key: "expenseAccountCode", header: "Cost/Expense Account Code", type: "text", example: "5010" },
      active,
    ],
  },
  employees: {
    kind: "employees", title: "Employees and Partners", singular: "Employee", model: "employee",
    fields: [
      { key: "code", header: "Employee No.", type: "text", required: true, example: "E-001", list: true },
      { key: "lastName", header: "Last Name", type: "text", required: true, example: "Dela Cruz", list: true },
      { key: "firstName", header: "First Name", type: "text", required: true, example: "Juan", list: true },
      { key: "middleName", header: "Middle Name", type: "text", example: "Santos" },
      { key: "position", header: "Position", type: "text", example: "Accounting Staff", list: true },
      { key: "department", header: "Department", type: "text", example: "Finance", list: true },
      { key: "email", header: "Email", type: "text", example: "juan@example.com" },
      { key: "tin", header: "TIN", type: "text", example: "123-456-789-000" },
      { key: "sssNo", header: "SSS No.", type: "text", example: "34-1234567-8" },
      { key: "philhealthNo", header: "PhilHealth No.", type: "text", example: "12-345678901-2" },
      { key: "pagibigNo", header: "Pag-IBIG MID No.", type: "text", example: "1234-5678-9012" },
      { key: "dateHired", header: "Date Hired", type: "date", example: "2025-01-15", help: "YYYY-MM-DD" },
      { key: "employmentStatus", header: "Employment Status", type: "enum", options: ["REGULAR", "PROBATIONARY", "CONTRACTUAL", "PROJECT"], example: "REGULAR" },
      { key: "payBasis", header: "Pay Basis", type: "enum", options: ["MONTHLY", "DAILY"], example: "MONTHLY" },
      { key: "basicRate", header: "Basic Rate", type: "number", example: 25000, help: "Monthly salary or daily rate depending on Pay Basis." },
      { key: "costCenter", header: "Cost Center Code", type: "text", example: "CC-SALES", help: "Default cost center for this person's expense and mobility claims." },
      { key: "projectCode", header: "Project Code", type: "text", example: "", help: "Default project for claims (dimension code)." },
      { key: "businessUnit", header: "Business Unit", type: "text", example: "" },
      { key: "supervisorCode", header: "Supervisor Employee No.", type: "text", example: "E-000", help: "The manager who approves this person's claims in the Veritus Mobility app (their Email must match their user login)." },
      { key: "workDaysPerYear", header: "Work Days per Year", type: "int", example: 261, help: "Daily-rate factor: 261 (Mon-Fri), 313 (Mon-Sat), 365. Default 261." },
      { key: "minimumWageEarner", header: "Minimum Wage Earner", type: "bool", example: false, help: "TRUE = basic, holiday, overtime and night differential pay are tax-exempt." },
      { key: "birthDate", header: "Birth Date", type: "date", example: "1990-05-20", help: "YYYY-MM-DD (for BIR 2316)" },
      { key: "address", header: "Address", type: "text", example: "123 Rizal St., Makati City" },
      { key: "bankAccountNo", header: "Payroll Bank Account No.", type: "text", example: "0012-3456-78" },
      { key: "isPartner", header: "Partner / Owner", type: "bool", example: false, list: true },
      active,
    ],
  },
  vendors: {
    kind: "vendors", title: "Vendors / Suppliers", singular: "Vendor", model: "vendor",
    fields: [
      { key: "code", header: "Vendor Code", type: "text", required: true, example: "V-0001", list: true },
      { key: "name", header: "Registered Name", type: "text", required: true, example: "ABC Office Supplies Inc.", list: true },
      { key: "tin", header: "TIN", type: "text", example: "000-123-456-00000", list: true },
      { key: "address", header: "Registered Address", type: "text", example: "123 Rizal Ave, Makati City" },
      { key: "contactPerson", header: "Contact Person", type: "text", example: "Maria Reyes" },
      { key: "email", header: "Email", type: "text", example: "billing@abc.ph" },
      { key: "phone", header: "Phone", type: "text", example: "0917 123 4567" },
      { key: "paymentTermsDays", header: "Payment Terms (days)", type: "int", example: 30, list: true },
      { key: "vatRegistered", header: "VAT Registered", type: "bool", example: true, list: true },
      { key: "ewtRate", header: "EWT Rate %", type: "number", example: 1, list: true, help: "Expanded withholding tax rate, e.g. 1 for goods, 2 for services." },
      { key: "atcCode", header: "ATC Code", type: "text", example: "WI158", help: "BIR alphanumeric tax code." },
      { key: "currencyCode", header: "Currency", type: "text", example: "PHP" },
      active,
    ],
  },
  customers: {
    kind: "customers", title: "Customers", singular: "Customer", model: "customer",
    fields: [
      { key: "code", header: "Customer Code", type: "text", required: true, example: "C-0001", list: true },
      { key: "name", header: "Registered Name", type: "text", required: true, example: "XYZ Trading Corp.", list: true },
      { key: "tin", header: "TIN", type: "text", example: "000-987-654-00000", list: true },
      { key: "address", header: "Registered Address", type: "text", example: "45 Osmeña Blvd, Cebu City" },
      { key: "contactPerson", header: "Contact Person", type: "text", example: "Pedro Lim" },
      { key: "email", header: "Email", type: "text", example: "ap@xyz.ph" },
      { key: "phone", header: "Phone", type: "text", example: "0998 765 4321" },
      { key: "paymentTermsDays", header: "Payment Terms (days)", type: "int", example: 30, list: true },
      { key: "creditLimit", header: "Credit Limit", type: "number", example: 500000, list: true },
      { key: "vatRegistered", header: "VAT Registered", type: "bool", example: true, list: true },
      { key: "withholdsTax", header: "Withholds Tax (issues 2307)", type: "bool", example: false, list: true },
      { key: "currencyCode", header: "Currency", type: "text", example: "PHP" },
      active,
    ],
  },
  currencies: {
    kind: "currencies", title: "Currencies", singular: "Currency", model: "currency",
    fields: [
      { key: "code", header: "Currency Code", type: "text", required: true, example: "USD", list: true, help: "3-letter ISO code." },
      { key: "name", header: "Currency Name", type: "text", required: true, example: "US Dollar", list: true },
      { key: "symbol", header: "Symbol", type: "text", example: "$", list: true },
      { key: "rateToBase", header: "Rate to PHP", type: "number", example: 58.25, list: true, help: "How many pesos per 1 unit of this currency." },
      active,
    ],
  },
  assets: {
    kind: "assets", title: "Fixed Asset Register", singular: "Fixed asset", model: "fixedAsset",
    fields: [
      { key: "code", header: "Asset No.", type: "text", required: true, example: "FA-000123", list: true, help: "Printed on the QR sticker." },
      { key: "name", header: "Description", type: "text", required: true, example: "Dell Latitude 5440 laptop", list: true },
      { key: "category", header: "Category", type: "text", example: "IT equipment", list: true },
      { key: "location", header: "Location", type: "text", example: "Makati HQ - 5F Finance", list: true },
      { key: "custodianCode", header: "Custodian Employee No.", type: "text", example: "E-001", list: true },
      { key: "serialNo", header: "Serial No.", type: "text", example: "5CG1234XYZ" },
      { key: "acquisitionDate", header: "Acquisition Date", type: "date", example: "2025-06-30", help: "YYYY-MM-DD" },
      { key: "cost", header: "Cost", type: "number", example: 65000, list: true },
      { key: "accountCode", header: "GL Account Code", type: "text", example: "1530" },
      { key: "tagCode", header: "Old Tag / Sticker No.", type: "text", example: "", help: "An existing sticker to map to this asset. Scanning it finds this asset." },
      { key: "status", header: "Status", type: "enum", options: ["ACTIVE", "FOR_REPAIR", "MISSING", "DISPOSED"], example: "ACTIVE", list: true },
      active,
    ],
  },
};

export const MASTER_KINDS = Object.keys(MASTERS) as MasterKind[];

export function isMasterKind(k: string): k is MasterKind {
  return k in MASTERS;
}
