import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string({
      required_error: "DATABASE_URL e obrigatoria",
    })
    .trim()
    .min(1, "DATABASE_URL nao pode ficar vazia")
    .url("DATABASE_URL deve ser uma URL valida")
    .refine((value) => value.startsWith("mysql://"), {
      message: "DATABASE_URL deve comecar com mysql://",
    }),
  WHATSAPP_ACCESS_TOKEN: z
    .string({
      required_error: "WHATSAPP_ACCESS_TOKEN e obrigatoria",
    })
    .trim()
    .min(1, "WHATSAPP_ACCESS_TOKEN nao pode ficar vazia"),
  WHATSAPP_PHONE_NUMBER_ID: z
    .string({
      required_error: "WHATSAPP_PHONE_NUMBER_ID e obrigatoria",
    })
    .trim()
    .min(1, "WHATSAPP_PHONE_NUMBER_ID nao pode ficar vazia"),
  WHATSAPP_VERIFY_TOKEN: z
    .string({
      required_error: "WHATSAPP_VERIFY_TOKEN e obrigatoria",
    })
    .trim()
    .min(1, "WHATSAPP_VERIFY_TOKEN nao pode ficar vazia"),
  WHATSAPP_APP_SECRET: z
    .string({
      required_error: "WHATSAPP_APP_SECRET e obrigatoria",
    })
    .trim()
    .min(1, "WHATSAPP_APP_SECRET nao pode ficar vazia"),
  WHATSAPP_API_VERSION: z.string().trim().default("v21.0"),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_MODEL: z.string().trim().default("gpt-4o-mini"),
  PHARMADB_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .default("https://api.pharmadb.com.br/v1"),
  PHARMADB_API_KEY: z.string().trim().optional(),
  PHARMADB_PMC_PRICE_MULTIPLIER: z.coerce
    .number()
    .positive()
    .default(0.5),
  MEDICINE_PRIMARY_PROVIDER: z
    .enum(["pharmadb", "bulapi", "popular_manual"])
    .default("pharmadb"),
  BULA_API_BASE_URL: z.string().trim().url().optional(),
  VIACEP_BASE_URL: z.string().trim().url().optional(),
  COSMOS_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .default("https://api.cosmos.bluesoft.com.br"),
  COSMOS_API_TOKEN: z.string().trim().optional(),
  COSMOS_USER_AGENT: z.string().trim().default("farmacia-whatsapp-ai"),
  COSMOS_PRICE_MULTIPLIER: z.coerce.number().positive().default(1),
  PIX_PROVIDER: z.string().trim().default("none"),
  PIX_MERCHANT_NAME: z.string().trim().optional(),
  PIX_MERCHANT_CITY: z.string().trim().optional(),
});

export function validateEnv(config: Record<string, unknown>) {
  const result = envSchema.safeParse(config);

  if (result.success) {
    return result.data;
  }

  const messages = result.error.issues.map((issue) => {
    const field = issue.path.join(".") || "ENV";
    return `- ${field}: ${issue.message}`;
  });

  throw new Error(
    `Variaveis de ambiente invalidas ou ausentes:\n${messages.join("\n")}`,
  );
}
