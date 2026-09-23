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
    const normalized = this.normalizeForIntent(text)
      .replace(/^(?:quero|preciso de|coloque|adiciona|pode colocar)\s+/, "")
      .replace(/\s+(?:por favor|pfv)$/, "");
    const match = normalized.match(/^(\d{1,2}|um|uma|dois|duas|tres|quatro|cinco)(?:\s*(?:x|caixas?|embalagens?|embalagem|pacotes?|frascos?|unidades?|un|desse|dessa|desses|dessas))?(?:\s+(?:com|de)\s+\d+\s+(?:unidades?|comprimidos?|capsulas?|pastilhas?))?$/);
    if (!match) return null;
    const words: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 };
    const value = words[match[1]] ?? Number(match[1]);

    if (!Number.isInteger(value) || value < 1 || value > 99) {
      return null;
    }

    return value;
  }

  packageCountInQuantity(text: string) {
    const match = this.normalizeForIntent(text).match(/\b(?:com|de)\s+(\d+)\s+(?:unidades?|comprimidos?|capsulas?|pastilhas?)\b/);
    return match ? Number(match[1]) : undefined;
  }

  isQuantityReply(text: string) {
    return this.parseQuantity(text) !== null || /^(?:quero\s+)?(?:\d+|um|uma|dois|duas)\s+(?:caixas?|embalagem|embalagens|pacotes?|frascos?|unidades?)\b/.test(this.normalizeForIntent(text));
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
