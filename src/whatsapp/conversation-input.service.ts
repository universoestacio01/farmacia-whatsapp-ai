import { Injectable } from "@nestjs/common";

@Injectable()
export class ConversationInputService {
  parseOptionNumber(text: string, max: number) {
    const value = Number(text.trim());

    if (!Number.isInteger(value) || value < 1 || value > max) {
      return null;
    }

    return value;
  }

  parseQuantity(text: string) {
    const normalized = text.trim().toLowerCase();

    if (/\b\d+\s*(mg|g|ml|mcg)\b/.test(normalized)) {
      return null;
    }

    const value = Number(normalized.replace(/\D/g, ""));

    if (!Number.isInteger(value) || value < 1 || value > 99) {
      return null;
    }

    return value;
  }

  parseCep(text: string) {
    const digits = text.replace(/\D/g, "");
    return digits.length === 8 ? digits : null;
  }

  isLikelyAddressNumber(text: string) {
    const normalized = text.trim();
    return /^[0-9A-Za-zÀ-ÿ][0-9A-Za-zÀ-ÿ\s/-]{0,20}$/.test(normalized);
  }

  normalizeForIntent(text: string) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[?!.:,;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
