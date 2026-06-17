export interface RetailProductManualOption {
  productName: string;
  displayName: string;
  brand?: string;
  description?: string;
  category: string;
}

export interface RetailProductConfig {
  aliases: string[];
  popularBrands: string[];
  options: RetailProductManualOption[];
}

export const RETAIL_PRODUCTS: Record<string, RetailProductConfig> = {
  shampoo: {
    aliases: [
      "shampoo",
      "xampu",
      "shampoo seda",
      "shampoo pantene",
      "shampoo dove",
      "shampoo clear",
      "shampoo elseve",
      "head shoulders",
      "head & shoulders",
      "johnson shampoo",
    ],
    popularBrands: [
      "Seda",
      "Pantene",
      "Dove",
      "Clear",
      "Elseve",
      "Head & Shoulders",
      "Johnson",
    ],
    options: [
      {
        productName: "Shampoo Seda",
        displayName: "Shampoo Seda",
        brand: "Seda",
        category: "shampoo",
      },
      {
        productName: "Shampoo Pantene",
        displayName: "Shampoo Pantene",
        brand: "Pantene",
        category: "shampoo",
      },
      {
        productName: "Shampoo Elseve",
        displayName: "Shampoo Elseve",
        brand: "Elseve",
        category: "shampoo",
      },
    ],
  },
  condicionador: {
    aliases: [
      "condicionador",
      "condicionador seda",
      "condicionador pantene",
      "condicionador dove",
      "condicionador elseve",
      "tresemme",
    ],
    popularBrands: ["Seda", "Pantene", "Dove", "Elseve", "Tresemme"],
    options: [
      {
        productName: "Condicionador Seda",
        displayName: "Condicionador Seda",
        brand: "Seda",
        category: "condicionador",
      },
      {
        productName: "Condicionador Pantene",
        displayName: "Condicionador Pantene",
        brand: "Pantene",
        category: "condicionador",
      },
      {
        productName: "Condicionador Dove",
        displayName: "Condicionador Dove",
        brand: "Dove",
        category: "condicionador",
      },
    ],
  },
  sabonete: {
    aliases: [
      "sabonete",
      "sabonete dove",
      "sabonete protex",
      "sabonete lux",
      "sabonete granado",
      "sabonete palmolive",
      "sabonete johnson",
    ],
    popularBrands: ["Dove", "Protex", "Lux", "Granado", "Palmolive", "Johnson"],
    options: [
      {
        productName: "Sabonete Dove",
        displayName: "Sabonete Dove",
        brand: "Dove",
        category: "sabonete",
      },
      {
        productName: "Sabonete Protex",
        displayName: "Sabonete Protex",
        brand: "Protex",
        category: "sabonete",
      },
      {
        productName: "Sabonete Granado",
        displayName: "Sabonete Granado",
        brand: "Granado",
        category: "sabonete",
      },
    ],
  },
  desodorante: {
    aliases: [
      "desodorante",
      "rexona",
      "nivea desodorante",
      "dove desodorante",
      "above",
      "monange",
    ],
    popularBrands: ["Rexona", "Nivea", "Dove", "Above", "Monange"],
    options: [
      {
        productName: "Desodorante Rexona",
        displayName: "Desodorante Rexona",
        brand: "Rexona",
        category: "desodorante",
      },
      {
        productName: "Desodorante Nivea",
        displayName: "Desodorante Nivea",
        brand: "Nivea",
        category: "desodorante",
      },
      {
        productName: "Desodorante Dove",
        displayName: "Desodorante Dove",
        brand: "Dove",
        category: "desodorante",
      },
    ],
  },
  "creme dental": {
    aliases: [
      "creme dental",
      "pasta de dente",
      "colgate",
      "oral b",
      "oral-b",
      "sensodyne",
      "closeup",
    ],
    popularBrands: ["Colgate", "Oral-B", "Sensodyne", "Closeup"],
    options: [
      {
        productName: "Colgate",
        displayName: "Colgate",
        brand: "Colgate",
        category: "creme dental",
      },
      {
        productName: "Oral-B",
        displayName: "Oral-B",
        brand: "Oral-B",
        category: "creme dental",
      },
      {
        productName: "Sensodyne",
        displayName: "Sensodyne",
        brand: "Sensodyne",
        category: "creme dental",
      },
    ],
  },
  "escova de dente": {
    aliases: ["escova de dente", "escova dental", "oral b escova", "condor"],
    popularBrands: ["Oral-B", "Colgate", "Condor"],
    options: [
      {
        productName: "Escova de dente Oral-B",
        displayName: "Escova de dente Oral-B",
        brand: "Oral-B",
        category: "escova de dente",
      },
      {
        productName: "Escova de dente Colgate",
        displayName: "Escova de dente Colgate",
        brand: "Colgate",
        category: "escova de dente",
      },
      {
        productName: "Escova de dente Condor",
        displayName: "Escova de dente Condor",
        brand: "Condor",
        category: "escova de dente",
      },
    ],
  },
  "fio dental": {
    aliases: ["fio dental"],
    popularBrands: ["Oral-B", "Colgate", "Sanifill"],
    options: [
      {
        productName: "Fio dental Oral-B",
        displayName: "Fio dental Oral-B",
        brand: "Oral-B",
        category: "fio dental",
      },
      {
        productName: "Fio dental Colgate",
        displayName: "Fio dental Colgate",
        brand: "Colgate",
        category: "fio dental",
      },
    ],
  },
  "enxaguante bucal": {
    aliases: ["enxaguante bucal", "antisseptico bucal"],
    popularBrands: ["Listerine", "Colgate", "Oral-B"],
    options: [
      {
        productName: "Enxaguante bucal Listerine",
        displayName: "Enxaguante bucal Listerine",
        brand: "Listerine",
        category: "enxaguante bucal",
      },
      {
        productName: "Enxaguante bucal Colgate",
        displayName: "Enxaguante bucal Colgate",
        brand: "Colgate",
        category: "enxaguante bucal",
      },
    ],
  },
  absorvente: {
    aliases: ["absorvente", "always", "intimus", "sempre livre", "carefree"],
    popularBrands: ["Always", "Intimus", "Sempre Livre", "Carefree"],
    options: [
      {
        productName: "Always",
        displayName: "Always",
        brand: "Always",
        category: "absorvente",
      },
      {
        productName: "Intimus",
        displayName: "Intimus",
        brand: "Intimus",
        category: "absorvente",
      },
      {
        productName: "Carefree",
        displayName: "Carefree",
        brand: "Carefree",
        category: "absorvente",
      },
    ],
  },
  fralda: {
    aliases: ["fralda", "pampers", "huggies", "mamy poko", "turma da monica"],
    popularBrands: ["Pampers", "Huggies", "MamyPoko", "Turma da Monica"],
    options: [
      {
        productName: "Pampers",
        displayName: "Pampers",
        brand: "Pampers",
        category: "fralda",
      },
      {
        productName: "Huggies",
        displayName: "Huggies",
        brand: "Huggies",
        category: "fralda",
      },
      {
        productName: "MamyPoko",
        displayName: "MamyPoko",
        brand: "MamyPoko",
        category: "fralda",
      },
    ],
  },
  "lenco umedecido": {
    aliases: [
      "lenco umedecido",
      "lenço umedecido",
      "toalha umedecida",
      "johnson lenco",
    ],
    popularBrands: ["Huggies", "Pampers", "Johnson", "Needs"],
    options: [
      {
        productName: "Lenco umedecido Johnson",
        displayName: "Lenco umedecido Johnson",
        brand: "Johnson",
        category: "lenco umedecido",
      },
      {
        productName: "Lenco umedecido Huggies",
        displayName: "Lenco umedecido Huggies",
        brand: "Huggies",
        category: "lenco umedecido",
      },
      {
        productName: "Lenco umedecido Pampers",
        displayName: "Lenco umedecido Pampers",
        brand: "Pampers",
        category: "lenco umedecido",
      },
    ],
  },
  gillette: {
    aliases: [
      "gillette",
      "gilete",
      "prestobarba",
      "aparelho de barbear",
      "lamina de barbear",
      "lâmina de barbear",
    ],
    popularBrands: ["Gillette Prestobarba", "Gillette Mach3", "Bic", "Bozzano"],
    options: [
      {
        productName: "Gillette Prestobarba",
        displayName: "Gillette Prestobarba",
        brand: "Gillette",
        category: "barbear",
      },
      {
        productName: "Gillette Mach3",
        displayName: "Gillette Mach3",
        brand: "Gillette",
        category: "barbear",
      },
      {
        productName: "Laminas Gillette",
        displayName: "Laminas Gillette",
        brand: "Gillette",
        category: "barbear",
      },
    ],
  },
  "protetor solar": {
    aliases: ["protetor solar", "filtro solar", "sundown", "nivea sun"],
    popularBrands: ["Nivea", "Sundown", "Neutrogena", "La Roche", "Cenoura & Bronze"],
    options: [
      {
        productName: "Protetor solar Nivea",
        displayName: "Protetor solar Nivea",
        brand: "Nivea",
        category: "protetor solar",
      },
      {
        productName: "Protetor solar Sundown",
        displayName: "Protetor solar Sundown",
        brand: "Sundown",
        category: "protetor solar",
      },
      {
        productName: "Protetor solar Neutrogena",
        displayName: "Protetor solar Neutrogena",
        brand: "Neutrogena",
        category: "protetor solar",
      },
    ],
  },
  hidratante: {
    aliases: ["hidratante", "creme hidratante", "nivea hidratante", "cetaphil"],
    popularBrands: ["Nivea", "Dove", "Neutrogena", "Cetaphil"],
    options: [
      {
        productName: "Hidratante Nivea",
        displayName: "Hidratante Nivea",
        brand: "Nivea",
        category: "hidratante",
      },
      {
        productName: "Hidratante Dove",
        displayName: "Hidratante Dove",
        brand: "Dove",
        category: "hidratante",
      },
      {
        productName: "Hidratante Neutrogena",
        displayName: "Hidratante Neutrogena",
        brand: "Neutrogena",
        category: "hidratante",
      },
    ],
  },
  algodao: {
    aliases: ["algodao", "algodão", "algodao needs", "algodao apolo"],
    popularBrands: ["Needs", "Apolo", "Cremer"],
    options: [
      {
        productName: "Algodao Needs",
        displayName: "Algodao Needs",
        brand: "Needs",
        category: "algodao",
      },
      {
        productName: "Algodao Apolo",
        displayName: "Algodao Apolo",
        brand: "Apolo",
        category: "algodao",
      },
    ],
  },
  cotonete: {
    aliases: ["cotonete", "hastes flexiveis", "johnson cotonete", "needs cotonete"],
    popularBrands: ["Johnson", "Needs", "Cottonbaby"],
    options: [
      {
        productName: "Cotonete Johnson",
        displayName: "Cotonete Johnson",
        brand: "Johnson",
        category: "cotonete",
      },
      {
        productName: "Cotonete Needs",
        displayName: "Cotonete Needs",
        brand: "Needs",
        category: "cotonete",
      },
    ],
  },
};
