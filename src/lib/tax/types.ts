// Shared types of the BIR tax engine. Sub-ledgers (AR, AP, payroll, expense claims, fixed assets...)
// feed the engine with TaxEntryInput rows; returns, attachments and alphalists read TaxLine rows.

export const TAX_KINDS = ["OUTPUT_VAT", "INPUT_VAT", "EWT", "FWT", "CWT", "VAT_WITHHELD", "PERCENTAGE", "PT_WITHHELD"] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const KIND_LABEL: Record<TaxKind | "EXCLUDED", string> = {
  OUTPUT_VAT: "Output VAT (sales)",
  INPUT_VAT: "Input VAT (purchases)",
  EWT: "Expanded withholding tax we withheld",
  FWT: "Final withholding tax we withheld",
  CWT: "Income tax withheld from us (2307 received)",
  VAT_WITHHELD: "VAT withheld from us (2307 received)",
  PERCENTAGE: "Percentage tax on sales",
  PT_WITHHELD: "Percentage tax withheld from us (2307 received)",
  EXCLUDED: "Not a tax transaction",
};

export const SALES_CLASSES = ["VATABLE", "GOVERNMENT", "ZERO_RATED", "EXEMPT"] as const;
export const PURCHASE_CLASSES = ["CAPITAL_GOODS", "GOODS", "SERVICES", "IMPORT_GOODS", "SERVICES_NONRESIDENT", "NOT_QUALIFIED", "ZERO_RATED", "EXEMPT"] as const;
export type SalesClass = (typeof SALES_CLASSES)[number];
export type PurchaseClass = (typeof PURCHASE_CLASSES)[number];

export const CLASS_LABEL: Record<string, string> = {
  VATABLE: "Vatable sales (private)",
  GOVERNMENT: "Sales to government",
  ZERO_RATED: "Zero-rated",
  EXEMPT: "VAT-exempt",
  CAPITAL_GOODS: "Capital goods",
  GOODS: "Domestic goods other than capital goods",
  SERVICES: "Domestic services",
  IMPORT_GOODS: "Importation of goods",
  SERVICES_NONRESIDENT: "Services by non-residents",
  NOT_QUALIFIED: "Purchases not qualified for input tax",
};

/** What a sub-ledger hands the engine for each taxable amount on its document. Amounts are PHP strings ("1234.50"). */
export type TaxEntryInput = {
  kind: TaxKind;
  /** Line key inside the source document (e.g. invoice line no.). Re-feeding the same key replaces the row. */
  ref: string;
  date: Date;
  taxBase: string;
  taxAmount: string;
  rate?: string | number;
  vatClass?: SalesClass | PurchaseClass | null;
  taxCodeId?: string | null;
  atcCode?: string | null;
  docType?: string | null;
  docNumber?: string | null;
  description?: string | null;
  journalLineId?: string | null;
  /** CUSTOMER | VENDOR | EMPLOYEE | PARTNER with the master record's id or code; TIN/name are looked up when not given. */
  party?: { type: string; id?: string | null; tin?: string | null; name?: string | null; lastName?: string | null; firstName?: string | null; middleName?: string | null; address?: string | null } | null;
};

/** One taxable amount as the reports see it, whichever module it came from. Amounts in centavos. */
export type TaxLine = {
  key: string;
  kind: TaxKind;
  vatClass: string | null;
  atcCode: string | null;
  rate: number;
  base: bigint;
  tax: bigint;
  date: Date;
  source: string;
  sourceId: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  journalLineId: string | null;
  docType: string | null;
  docNumber: string | null;
  description: string | null;
  party: Party;
};

export type Party = {
  type: string | null;
  id: string | null;
  tin: string | null;
  name: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  address: string | null;
};

// ---------- Payroll hooks (BIR 1601-C, 1604-C alphalist, 2316) ----------
// Payroll implements a CompensationFeed and registers it with registerCompensationFeed();
// the tax engine then lists employees in the 1604-C alphalist and prints 2316 data.

/** Annual compensation of one employee, as BIR Form 2316 lays it out. Amounts in PHP strings. */
export type Bir2316Data = {
  employeeId: string;
  year: number;
  periodFrom: Date;
  periodTo: Date;
  tin: string | null;
  lastName: string; firstName: string; middleName?: string | null;
  address?: string | null; zipCode?: string | null; birthDate?: Date | null;
  minimumWageEarner: boolean;
  /** Present employer */
  grossCompensation: string;
  nonTaxable: {
    basicSmw?: string; holidayPay?: string; overtimePay?: string; nightDiff?: string; hazardPay?: string;
    thirteenthMonthAndOther?: string; // capped at P90,000 (TRAIN)
    deMinimis?: string; govContributions?: string; // employee share of SSS/PhilHealth/Pag-IBIG and union dues
    salariesOther?: string;
  };
  taxable: { basic?: string; representation?: string; transportation?: string; cola?: string; housing?: string; others?: string; commission?: string; profitSharing?: string; directorsFees?: string; thirteenthMonthExcess?: string; hazardPay?: string; overtimePay?: string; othersSupplementary?: string };
  taxableFromPreviousEmployer?: string;
  taxDue: string;
  taxWithheldPresent: string;
  taxWithheldPrevious?: string;
  substitutedFiling: boolean;
};

/** One line of the 1601-C monthly remittance, from a posted payroll. */
export type CompensationWithholding = { month: Date; taxableCompensation: string; nonTaxable: string; taxWithheld: string; employees: number };

export type CompensationFeed = {
  year2316(organizationId: string, year: number): Promise<Bir2316Data[]>;
  monthly1601C(organizationId: string, from: Date, to: Date): Promise<CompensationWithholding[]>;
};

let compensationFeed: CompensationFeed | null = null;
export function registerCompensationFeed(f: CompensationFeed) { compensationFeed = f; }
export function getCompensationFeed() { return compensationFeed; }
