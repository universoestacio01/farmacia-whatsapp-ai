export interface RetailProductManualOption {
  productName: string;
  displayName: string;
  brand?: string;
  description?: string;
  category: string;
}

export interface RetailProductConfig {
  aliases: string[];
  options: RetailProductManualOption[];
}

export const RETAIL_PRODUCTS: Record<string, RetailProductConfig> = {
  gillette: {
    aliases: [
      "gillette",
      "gilete",
      "prestobarba",
      "aparelho de barbear",
      "lamina de barbear",
      "lâmina de barbear",
    ],
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
  sabonete: {
    aliases: [
      "sabonete",
      "sabonete dove",
      "sabonete protex",
      "sabonete granado",
      "dove",
      "protex",
      "granado",
    ],
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
  shampoo: {
    aliases: [
      "shampoo",
      "xampu",
      "condicionador",
      "seda",
      "pantene",
      "elseve",
      "head shoulders",
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
  desodorante: {
    aliases: [
      "desodorante",
      "rexona",
      "nivea",
      "nivea desodorante",
      "dove desodorante",
    ],
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
      "escova de dente",
      "fio dental",
      "enxaguante bucal",
      "colgate",
      "oral b",
      "oral-b",
      "sensodyne",
    ],
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
  absorvente: {
    aliases: ["absorvente", "always", "intimus", "carefree"],
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
    aliases: ["fralda", "pampers", "huggies", "mamy poko"],
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
      "johnson lenço",
    ],
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
  hidratante: {
    aliases: [
      "hidratante",
      "creme hidratante",
      "nivea hidratante",
      "needs hidratante",
      "needs",
    ],
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
        productName: "Hidratante Needs",
        displayName: "Hidratante Needs",
        brand: "Needs",
        category: "hidratante",
      },
    ],
  },
  perfume: {
    aliases: ["perfume", "colonia", "colônia", "desodorante colonia"],
    options: [
      {
        productName: "Perfume",
        displayName: "Perfume",
        category: "perfume",
      },
      {
        productName: "Colonia",
        displayName: "Colonia",
        category: "perfume",
      },
    ],
  },
  "protetor solar": {
    aliases: ["protetor solar", "filtro solar", "sundown", "nivea sun", "needs solar"],
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
        productName: "Protetor solar Needs",
        displayName: "Protetor solar Needs",
        brand: "Needs",
        category: "protetor solar",
      },
    ],
  },
  repelente: {
    aliases: ["repelente", "off repelente", "repelex", "needs repelente"],
    options: [
      {
        productName: "Repelente Off",
        displayName: "Repelente Off",
        brand: "Off",
        category: "repelente",
      },
      {
        productName: "Repelente Repelex",
        displayName: "Repelente Repelex",
        brand: "Repelex",
        category: "repelente",
      },
      {
        productName: "Repelente Needs",
        displayName: "Repelente Needs",
        brand: "Needs",
        category: "repelente",
      },
    ],
  },
  algodao: {
    aliases: ["algodao", "algodão", "algodao needs", "algodao apolo"],
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
