import type { DimensionType } from "@prisma/client";

// Journal line column for each dimension type.
export const DIMENSIONS: { type: DimensionType; key: DimKey; label: string }[] = [
  { type: "DEPARTMENT", key: "departmentId", label: "Department" },
  { type: "BRANCH", key: "branchId", label: "Branch" },
  { type: "BUSINESS_UNIT", key: "businessUnitId", label: "Business Unit" },
  { type: "PROJECT", key: "projectId", label: "Project" },
  { type: "COST_CENTER", key: "costCenterId", label: "Cost Center" },
  { type: "PROFIT_CENTER", key: "profitCenterId", label: "Profit Center" },
  { type: "LOCATION", key: "locationId", label: "Location" },
  { type: "PRODUCT_LINE", key: "productLineId", label: "Product Line" },
  { type: "DIVISION", key: "divisionId", label: "Division" },
];

export type DimKey =
  | "departmentId" | "branchId" | "businessUnitId" | "projectId"
  | "costCenterId" | "profitCenterId" | "locationId" | "productLineId" | "divisionId";

export const DIM_KEYS = DIMENSIONS.map((d) => d.key);
export const dimKeyFor = (t: DimensionType) => DIMENSIONS.find((d) => d.type === t)!.key;
