import { SymptomMedicineRule } from "../config/symptom-medicine.config";
import { removeMedicineStrengths } from "./medicine-strength.util";

export function foldCustomerQuery(text: string) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Detect separate requests, but keep combination medicines and concentration fractions intact.
export function hasMultipleProductRequests(text: string) {
  if (/\b(?:kit|combo|conjunto|2\s*em\s*1)\b/i.test(text)) return false;
  if (/^(?:estou|to|sinto|estou sentindo|tenho dor)\b/.test(foldCustomerQuery(text))) return false;
  const parts = text.split(/\n|;|\s+e\s+/i).map(foldCustomerQuery);
  const names = parts.map(part => removeMedicineStrengths(part)
    .replace(/\b(?:eu|um|uma|com|de|do|da|quero|preciso|caixa|caixas|comprimidos?|capsulas?|mg|ml|g|dor|febre|alivio|rapido|solucao|gotas|spray)\b|\d+/g, " ")
    .replace(/[^a-z]/g, "").trim()).filter(name => name.length >= 3);
  return names.length > 1;
}

export function namedQueryBeforeSymptom(text: string, symptom: SymptomMedicineRule) {
  let query = foldCustomerQuery(text);
  for (const phrase of [...symptom.patterns, symptom.label].sort((a, b) => b.length - a.length)) {
    const escaped = foldCustomerQuery(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query = query.replace(new RegExp(`\\b${escaped}\\b`, "g"), " ");
  }
  query = query.replace(/\b(?:antialergicos?|alivio rapido|para|pra|de|da|do|dor|e|remedio|medicamento|estou|to|com|tenho|sentindo|muita?|forte|persistente|alta|um|uma|qual|bom|melhor|preciso|quero|algo|tomar)\b/g, " ").replace(/\s+/g, " ").trim();
  const name = removeMedicineStrengths(query).replace(/\b(?:pastilhas?|comprimidos?|capsulas?|gotas|xarope|pomada|solucao|nasal|oral)\b/g, " ").replace(/[^a-z]/g, "");
  return name.length >= 3 ? query : null;
}
