// Suggestions require explicit customer confirmation; they are not aliases or substitutions.
const MEDICINE_SPELLING_SUGGESTIONS: Readonly<Record<string, string>> = {
  dranim: "Dramin",
  dramim: "Dramin",
};

export function medicineSpellingSuggestion(name: string) {
  return MEDICINE_SPELLING_SUGGESTIONS[name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()];
}
