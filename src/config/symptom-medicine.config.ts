export interface SymptomMedicineCandidate {
  medicineName: string;
  reason: string;
}

export interface SymptomMedicineRule {
  key: string;
  label: string;
  patterns: string[];
  candidates: SymptomMedicineCandidate[];
  safetyNote?: string;
  clarificationQuestion?: string;
}

export const SYMPTOM_MEDICINE_RULES: SymptomMedicineRule[] = [
  {
    key: "dor_barriga",
    label: "dor de barriga",
    patterns: [
      "dor de barriga",
      "dor abdominal",
      "colica",
      "cólica",
      "barriga doendo",
      "dor no estomago",
      "dor no estômago",
    ],
    candidates: [
      { medicineName: "Buscopan", reason: "opção comum para cólicas" },
      { medicineName: "Luftal", reason: "opção comum quando há gases" },
    ],
    safetyNote:
      "Se a dor for forte, persistente, vier com febre, vômitos, sangue ou gravidez, é importante falar com um médico ou farmacêutico.",
  },
  {
    key: "febre",
    label: "febre",
    patterns: ["febre", "febril", "temperatura alta"],
    candidates: [
      { medicineName: "Dipirona", reason: "opção comum para febre" },
      { medicineName: "Paracetamol", reason: "opção comum para febre" },
      { medicineName: "Ibuprofeno", reason: "opção comum para dor e febre" },
    ],
    safetyNote:
      "Se a febre for alta, persistente, em criança pequena, gestante ou vier com falta de ar, procure atendimento profissional.",
  },
  {
    key: "gripe_resfriado",
    label: "gripe ou resfriado",
    patterns: ["gripe", "resfriado", "resfriada", "resfriado forte"],
    candidates: [
      { medicineName: "Cimegripe", reason: "opção comum para sintomas de gripe" },
      { medicineName: "Benegrip", reason: "opção comum para sintomas de gripe" },
      { medicineName: "Dipirona", reason: "opção comum para febre e dor" },
      { medicineName: "Paracetamol", reason: "opção comum para febre e dor" },
    ],
    safetyNote:
      "Se houver falta de ar, dor no peito, febre persistente ou piora importante, procure atendimento profissional.",
  },
  {
    key: "dor_cabeca",
    label: "dor de cabeça",
    patterns: ["dor de cabeca", "dor de cabeça", "cefaleia", "enxaqueca"],
    candidates: [
      { medicineName: "Dipirona", reason: "opção comum para dor" },
      { medicineName: "Paracetamol", reason: "opção comum para dor" },
      { medicineName: "Ibuprofeno", reason: "opção comum para dor" },
      { medicineName: "Dorflex", reason: "opção comum quando há tensão muscular" },
    ],
    safetyNote:
      "Se a dor for muito forte, diferente do habitual, vier com alteração visual, desmaio ou rigidez na nuca, procure atendimento profissional.",
  },
  {
    key: "nariz_entupido",
    label: "nariz entupido",
    patterns: ["nariz entupido", "congestao nasal", "congestão nasal", "nariz congestionado"],
    candidates: [
      { medicineName: "Neosoro", reason: "opção comum para congestão nasal" },
      { medicineName: "soro fisiológico nasal", reason: "opção comum para higiene nasal" },
    ],
  },
  {
    key: "alergia",
    label: "alergia",
    patterns: ["alergia", "alergico", "alérgico", "coceira", "rinite"],
    candidates: [
      { medicineName: "Loratadina", reason: "opção comum para alergia" },
      { medicineName: "Allegra", reason: "opção comum para alergia" },
    ],
    safetyNote:
      "Se houver falta de ar, inchaço no rosto ou reação intensa, procure atendimento imediatamente.",
  },
  {
    key: "azia",
    label: "azia",
    patterns: ["azia", "queimacao", "queimação", "refluxo"],
    candidates: [
      { medicineName: "Omeprazol", reason: "opção comum para azia e refluxo" },
    ],
  },
  {
    key: "gases",
    label: "gases",
    patterns: ["gases", "estufamento", "barriga inchada"],
    candidates: [
      { medicineName: "Luftal", reason: "opção comum para gases" },
    ],
  },
  {
    key: "dor_muscular",
    label: "dor muscular",
    patterns: ["dor muscular", "dor nas costas", "torcicolo", "mialgia"],
    candidates: [
      { medicineName: "Dorflex", reason: "opção comum para dor por tensão muscular" },
      { medicineName: "Torsilax", reason: "opção comum para dor muscular" },
      { medicineName: "Ibuprofeno", reason: "opção comum para dor" },
    ],
  },
  {
    key: "tosse",
    label: "tosse",
    patterns: ["tosse"],
    candidates: [],
    clarificationQuestion:
      "Para tosse, preciso saber: é tosse seca ou com catarro? Assim eu procuro a opção mais adequada para você.",
  },
  {
    key: "dor_garganta",
    label: "dor de garganta",
    patterns: ["dor de garganta", "garganta inflamada", "garganta doendo"],
    candidates: [
      { medicineName: "Neopiridin", reason: "opção comum de pastilha para garganta" },
      { medicineName: "Dipirona", reason: "opção comum para dor" },
      { medicineName: "Paracetamol", reason: "opção comum para dor" },
    ],
    safetyNote:
      "Se tiver febre persistente, pus na garganta ou dificuldade para engolir, procure orientação profissional.",
  },
];
