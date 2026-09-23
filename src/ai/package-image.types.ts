import { z } from "zod";

const label = z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N} .,%/+()-]+$/u);
export const packageImageSchema = z.object({
  medicineName: label.nullable(),
  dosage: label.max(60).nullable(),
  form: label.max(60).nullable(),
  confidence: z.number().min(0).max(1),
});

export type PackageImageReading = z.infer<typeof packageImageSchema>;
export type PackageImageResult =
  | { status: "identified"; reading: PackageImageReading }
  | { status: "unavailable" | "unreadable" | "failed" | "unsupported" };
