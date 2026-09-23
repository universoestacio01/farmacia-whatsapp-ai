export interface MedicineStrength {
  raw: string;
  label: string;
  mg: number;
  denominator?: "ml" | "g";
  per: number;
}

const strengthPattern = /\b(\d+(?:[,.]\d+)?)\s*(mcg|mg|g)\b(?:\s*\/\s*(?:(\d+(?:[,.]\d+)?)\s*)?(ml|g)\b)?/g;

/** Keep concentration dimensions and every component; a bottle is not a tablet. */
export function extractMedicineStrengths(value: string): MedicineStrength[] {
  const text = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return [...text.matchAll(strengthPattern)].flatMap((match) => {
    const amount = Number(match[1].replace(",", "."));
    const per = Number((match[3] || "1").replace(",", "."));
    if (!(amount > 0) || !(per > 0)) return [];
    // Grams on topical products describe the tube/jar, not its strength.
    if (match[2] === "g" && !match[4] && /\b(?:creme|pomada|gel|geleia|bisnaga|saches?|po para)\b/.test(text)) return [];
    return [{
      raw: match[0],
      label: match[0].replace(/\s+/g, ""),
      mg: amount * (match[2] === "g" ? 1000 : match[2] === "mcg" ? 0.001 : 1),
      denominator: match[4] as MedicineStrength["denominator"],
      per,
    }];
  });
}

export function medicineStrengthSignature(value: string): string {
  return extractMedicineStrengths(value).map((strength) =>
    `${Number((strength.mg / strength.per).toPrecision(12))}mg${strength.denominator ? `/${strength.denominator}` : ""}`,
  ).join("+");
}

export function medicineStrengthMatches(actual: string, requested: string): boolean {
  const signature = medicineStrengthSignature(requested);
  return Boolean(signature) && medicineStrengthSignature(actual) === signature;
}

/** Match a labeled single-pen amount without treating arbitrary liquids as doses. */
export function medicinePresentationStrengthMatches(actual: string, requested: string, productName: string): boolean {
  if (medicineStrengthMatches(actual, requested)) return true;
  const name = productName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const pen = name.match(/\bcanetas?\s+(?:de\s+)?(\d+(?:[,.]\d+)?)\s*ml\b/);
  if (!pen || !/\binjetave(?:l|is)\b/.test(name) || /\b(?:multidose|multiplas doses)\b/.test(name)) return false;
  const strengths = extractMedicineStrengths(actual);
  const request = extractMedicineStrengths(requested);
  if (strengths.length !== 1 || request.length !== 1 || request[0].denominator) return false;
  const strength = strengths[0];
  // Require the explicit denominator to equal the labeled pen volume. No
  // multiplication by bottle volume or inference about an administration dose.
  return strength.denominator === "ml" &&
    strength.per === Number(pen[1].replace(",", ".")) &&
    strength.mg === request[0].mg;
}

export function removeMedicineStrengths(value: string): string {
  return value.replace(strengthPattern, " ");
}
