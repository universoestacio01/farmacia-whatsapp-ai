import { Injectable } from "@nestjs/common";
import { parseAddressField } from "./delivery-address";

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
    return parseAddressField("cep", text);
  }

  isLikelyAddressNumber(text: string) {
    return parseAddressField("number", text) !== null;
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
