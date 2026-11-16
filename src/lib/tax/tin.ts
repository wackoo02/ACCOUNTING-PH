// TIN helpers (pure).
export function normTin(t: string | null | undefined) {
  return (t ?? "").replace(/\D/g, "");
}

/** "123-456-789-00000" -> tin9 123456789, branch "0000" (alphalists use a 4-digit branch code). */
export function splitTin(tin: string | null | undefined) {
  const d = normTin(tin);
  const tin9 = d.slice(0, 9);
  let br = d.slice(9);
  if (br.length > 4 && br.startsWith("0")) br = br.slice(-4);
  return { tin9, branch: (br || "0000").padStart(4, "0").slice(0, 5) };
}

export const tinValid = (tin: string | null | undefined) => normTin(tin).length >= 9;

export function formatTin(tin: string | null | undefined) {
  const d = normTin(tin);
  if (d.length < 9) return tin ?? "";
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.slice(9) || "000"].join("-");
}
