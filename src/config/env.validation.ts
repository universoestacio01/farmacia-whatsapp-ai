import { z } from "zod";
import {
  DEFAULT_PIX_KEY,
  DEFAULT_PIX_MERCHANT_CITY,
  DEFAULT_PIX_MERCHANT_NAME,
} from "./direct-pix.config";
import { sanitizeEnv } from "./env-sanitize";

const sanitizedOptionalString = z.preprocess((value) => {
  const sanitized = sanitizeEnv(value);
  return sanitized || undefined;
}, z.string().optional());

const sanitizedString = z.preprocess(
  (value) => sanitizeEnv(value),
  z.string(),
);

const sanitizedBoolean = z.preprocess((value) => {
  const sanitized = sanitizeEnv(value).toLowerCase();

  if (["true", "1", "yes", "sim"].includes(sanitized)) {
    return true;
  }

  if (["false", "0", "no", "nao", "não", ""].includes(sanitized)) {
    return false;
  }

  return value;
}, z.coerce.boolean());

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().trim().url().optional(),
  PUBLIC_APP_URL: z.string().trim().url().optional(),
  ADMIN_TOKEN: sanitizedOptionalString,
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
  WHATSAPP_API_VERSION: z.string().trim().default("v25.0"),
  OPENAI_API_KEY: sanitizedOptionalString,
  OPENAI_VISION_MODEL: sanitizedOptionalString,
  OPENAI_MODEL: z.string().trim().default("gpt-4o-mini"),
  OPENAI_WEB_SEARCH_ENABLED: sanitizedBoolean.default(true),
  OPENAI_WEB_SEARCH_MODEL: sanitizedString.default("gpt-5-mini"),
  OPENAI_WEB_SEARCH_DAILY_LIMIT: z.coerce.number().int().min(0).max(1000).default(40),
  PRECO_POPULAR_ENABLED: sanitizedBoolean.default(true),
  PRECO_POPULAR_PRICE_MULTIPLIER: z.unknown().transform(() => 1),
  PHARMADB_ENABLED: z.unknown().transform(() => false),
  PHARMADB_API_KEY: sanitizedOptionalString,
  PHARMADB_API_BASE_URL: z.preprocess(sanitizeEnv, z.string().url().startsWith("https://")).default("https://api.pharmadb.com.br/v1"),
  PHARMADB_PMC_PRICE_MULTIPLIER: z.preprocess((value) => sanitizeEnv(value) || "0.5", z.coerce.number().positive().max(1)),
  BULAPI_ENABLED: z.unknown().transform(() => false),
  BULA_API_BASE_URL: z.preprocess(sanitizeEnv, z.string().url().startsWith("https://")).default("https://bulapi.com.br/api/v1"),
  VIACEP_BASE_URL: z.string().trim().url().optional(),
  PIX_PROVIDER: sanitizedString.default("pix_direct"),
  PIX_KEY: sanitizedString.default(DEFAULT_PIX_KEY),
  PIX_STATIC_KEY: sanitizedOptionalString,
  PIX_MERCHANT_NAME: sanitizedString.default(DEFAULT_PIX_MERCHANT_NAME),
  PIX_MERCHANT_CITY: sanitizedString.default(DEFAULT_PIX_MERCHANT_CITY),
  SIGILOPAY_API_BASE_URL: z.preprocess(
    (value) => sanitizeEnv(value),
    z.string().url(),
  ).default("https://app.sigilopay.com.br/api/v1"),
  SIGILOPAY_CALLBACK_URL: z.preprocess(
    (value) => sanitizeEnv(value),
    z.string().url(),
  ).default("https://farmaciadeliveryraia.com/webhook/sigilopay"),
  SIGILOPAY_PUBLIC_KEY: sanitizedOptionalString,
  SIGILOPAY_SECRET_KEY: sanitizedOptionalString,
  SIGILOPAY_WEBHOOK_TOKEN: sanitizedOptionalString,
  SIGILOPAY_WEBHOOK_SECRET: sanitizedOptionalString,
  SIGILOPAY_ENABLED: sanitizedBoolean.default(false),
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

