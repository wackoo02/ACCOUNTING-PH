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

export type MasterKind = "accounts" | "dimensions" | "taxes" | "banks" | "products" | "employees" | "vendors" | "customers" | "currencies" | "assets" | "asset-categories" | "warehouses" | "locations";

export type MasterDef = {
  kind: MasterKind;
  title: string;
  singular: string;
  model: "account" | "dimensionValue" | "taxCode" | "bankAccount" | "product" | "employee" | "vendor" | "customer" | "currency" | "fixedAsset" | "assetCategory" | "warehouse" | "warehouseLocation";
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
      { key: "isStocked", header: "Track Inventory", type: "bool", example: true, list: true, help: "TRUE = an inventory item: tracked by warehouse in the stock ledger and costed under PAS 2. Default FALSE." },
      { key: "category", header: "Item Category", type: "text", example: "Office supplies", list: true },
      { key: "barcode", header: "Barcode", type: "text", example: "4800016644108", help: "EAN/UPC or your own code. A barcode scanner can type it into any item box." },
      { key: "costingMethod", header: "Costing Method", type: "enum", options: ["WEIGHTED_AVERAGE", "FIFO", "SPECIFIC"], example: "WEIGHTED_AVERAGE", list: true, help: "PAS 2: WEIGHTED_AVERAGE (moving average per warehouse), FIFO, or SPECIFIC identification (each lot/serial no. keeps its own cost). LIFO is not allowed. Cannot change once the item has stock movements." },
      { key: "standardCost", header: "Standard Cost", type: "number", example: 190, help: "Reference cost per unit. Used as the default cost of receipts and count gains when there is no other cost." },
      { key: "reorderPoint", header: "Reorder Point", type: "number", example: 20, help: "Stock status flags the item when on hand falls to or below this." },
      { key: "reorderQty", header: "Reorder Quantity", type: "number", example: 100 },
      { key: "defaultWarehouseCode", header: "Default Warehouse", type: "text", example: "WH-MAIN" },
      { key: "defaultLocationCode", header: "Default Location / Bin", type: "text", example: "A-01" },
      { key: "defaultVendorCode", header: "Default Vendor Code", type: "text", example: "V-0001" },
      { key: "inventoryAccountCode", header: "Inventory GL Account", type: "text", example: "1200", help: "Blank = the account with the INVENTORY role (1200 Merchandise Inventory)." },
      { key: "cogsAccountCode", header: "COGS Account", type: "text", example: "5010", help: "Charged when the item is sold or issued. Blank = Cost/Expense Account Code, then 5010 Cost of Goods Sold." },
      active,
    ],
  },
  warehouses: {
    kind: "warehouses", title: "Warehouses", singular: "Warehouse", model: "warehouse",
    fields: [
      { key: "code", header: "Warehouse Code", type: "text", required: true, example: "WH-MAIN", list: true },
      { key: "name", header: "Warehouse Name", type: "text", required: true, example: "Main Warehouse - Valenzuela", list: true },
      { key: "address", header: "Address", type: "text", example: "Km 14 MacArthur Hwy, Valenzuela City", list: true },
      { key: "branchCode", header: "Branch Code", type: "text", example: "", list: true, help: "Optional BRANCH dimension code. Inventory GL lines of this warehouse are tagged with it." },
      active,
    ],
  },
  locations: {
    kind: "locations", title: "Warehouse Locations (Bins)", singular: "Location", model: "warehouseLocation",
    fields: [
      { key: "warehouseCode", header: "Warehouse Code", type: "text", required: true, example: "WH-MAIN", list: true },
      { key: "code", header: "Location Code", type: "text", required: true, example: "A-01", list: true, help: "Rack / shelf / bin, e.g. A-01-03. Unique within the warehouse." },
      { key: "name", header: "Description", type: "text", required: true, example: "Aisle A, rack 1", list: true },
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
      { key: "businessStyle", header: "Business Style", type: "text", example: "XYZ Hardware", help: "Trade name printed on the sales invoice under the registered name." },
      { key: "invoiceEmails", header: "Invoice Emails", type: "text", example: "ap@xyz.ph; finance@xyz.ph", help: "Where invoices, receipts and statements are emailed. Separate several with ; or ," },
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
  "asset-categories": {
    kind: "asset-categories", title: "Asset Categories", singular: "Asset category", model: "assetCategory",
    fields: [
      { key: "code", header: "Category Code", type: "text", required: true, example: "IT", list: true },
      { key: "name", header: "Category Name", type: "text", required: true, example: "IT equipment", list: true },
      { key: "prefix", header: "Asset No. Prefix", type: "text", example: "IT", list: true, help: "New assets in this category are numbered PREFIX-000001. Blank = FA." },
      { key: "assetAccountCode", header: "GL Asset Account", type: "text", required: true, example: "1530", list: true, help: "Property and equipment cost account." },
      { key: "accumDepAccountCode", header: "Accumulated Depreciation Account", type: "text", example: "1535", list: true, help: "Blank only for land (not depreciated)." },
      { key: "depExpenseAccountCode", header: "Depreciation Expense Account", type: "text", example: "6090", list: true },
      { key: "usefulLifeMonths", header: "Useful Life (months)", type: "int", required: true, example: 36, list: true, help: "Default for new assets, e.g. 36 for laptops, 60 for vehicles, 240 for buildings." },
      { key: "depreciationMethod", header: "Depreciation Method", type: "enum", options: ["STRAIGHT_LINE", "DECLINING_BALANCE", "SUM_OF_YEARS", "NONE"], example: "STRAIGHT_LINE", list: true, help: "NONE for land." },
      { key: "salvagePct", header: "Salvage Value % of Cost", type: "number", example: 0, help: "Default residual value, e.g. 10 for 10%." },
      active,
    ],
  },
  assets: {
    kind: "assets", title: "Fixed Asset Register", singular: "Fixed asset", model: "fixedAsset",
    fields: [
      { key: "code", header: "Asset No.", type: "text", required: true, example: "FA-000123", list: true, help: "Printed on the QR sticker." },
      { key: "name", header: "Description", type: "text", required: true, example: "Dell Latitude 5440 laptop", list: true },
      { key: "categoryCode", header: "Category Code", type: "text", example: "IT", list: true, help: "From Asset Categories. Fills in blank accounts, useful life and method." },
      { key: "serialNo", header: "Serial No.", type: "text", example: "5CG1234XYZ" },
      { key: "location", header: "Location", type: "text", example: "Makati HQ - 5F Finance", list: true },
      { key: "departmentCode", header: "Department Code", type: "text", example: "FIN", help: "Dimension code; depreciation is charged to it." },
      { key: "costCenterCode", header: "Cost Center Code", type: "text", example: "CC-ADMIN", help: "Dimension code; depreciation is charged to it." },
      { key: "custodianCode", header: "Custodian Employee No.", type: "text", example: "E-001", list: true },
      { key: "vendorCode", header: "Vendor Code", type: "text", example: "V-0001" },
      { key: "poNumber", header: "PO / Invoice No.", type: "text", example: "PO-2025-000041" },
      { key: "acquisitionDate", header: "Purchase Date", type: "date", example: "2025-06-30", help: "YYYY-MM-DD" },
      { key: "inServiceDate", header: "In-Service Date", type: "date", example: "", help: "When it was ready for use. Blank = purchase date. On or before the 15th depreciates from that month, otherwise from the next." },
      { key: "cost", header: "Acquisition Cost", type: "number", example: 65000, list: true },
      { key: "salvageValue", header: "Salvage Value", type: "number", example: 0, help: "Blank = the category's salvage %." },
      { key: "usefulLifeMonths", header: "Useful Life (months)", type: "int", example: 36, help: "Blank = the category's useful life." },
      { key: "depreciationMethod", header: "Depreciation Method", type: "enum", options: ["STRAIGHT_LINE", "DECLINING_BALANCE", "SUM_OF_YEARS", "NONE"], example: "STRAIGHT_LINE" },
      { key: "accountCode", header: "GL Asset Account", type: "text", example: "1530" },
      { key: "accumDepAccountCode", header: "Accumulated Depreciation Account", type: "text", example: "1535" },
      { key: "depExpenseAccountCode", header: "Depreciation Expense Account", type: "text", example: "6090" },
      { key: "accumulatedDepreciation", header: "Opening Accumulated Depreciation", type: "number", example: 0, help: "For assets already partly depreciated before go-live (already in your GL opening balance)." },
      { key: "depreciatedThrough", header: "Depreciated Through", type: "date", example: "", help: "Last month-end covered by the opening accumulated depreciation, e.g. 2025-12-31." },
      { key: "tagCode", header: "Old Tag / Sticker No.", type: "text", example: "", help: "An existing sticker to map to this asset. Scanning it finds this asset." },
      { key: "status", header: "Status", type: "enum", options: ["ACTIVE", "FOR_REPAIR", "MISSING"], example: "ACTIVE", list: true, help: "Sell or retire assets from the asset's page, not here." },
      active,
    ],
  },
};

export const MASTER_KINDS = Object.keys(MASTERS) as MasterKind[];

export function isMasterKind(k: string): k is MasterKind {
  return k in MASTERS;
}
