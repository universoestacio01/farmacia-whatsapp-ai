import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { parseAddressField } from "../whatsapp/delivery-address";

export interface ViaCepAddress {
  cep: string;
  logradouro: string;
  complemento: string;
  bairro: string;
  localidade: string;
  uf: string;
  erro?: boolean;
}

@Injectable()
export class ViaCepService {
  private readonly logger = new Logger(ViaCepService.name);

  constructor(private readonly configService: ConfigService) {}

  async findAddressByCep(cep: string): Promise<ViaCepAddress | null> {
    const cleanCep = parseAddressField("cep", cep);

    if (!cleanCep) {
      return null;
    }

    const baseUrl =
      this.configService.get<string>("VIACEP_BASE_URL") ||
      "https://viacep.com.br/ws";
    const url = `${baseUrl}/${cleanCep}/json/`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

      if (!response.ok) {
        this.logger.warn(
          `ViaCEP respondeu ${response.status} para ${cleanCep}`,
        );
        return null;
      }

      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      const raw = data as Record<string, unknown>;
      if (raw.erro) return null;
      const field = (key: string) => typeof raw[key] === "string" ? raw[key].trim() : "";
      if (!field("localidade") || !parseAddressField("uf", raw.uf)) return null;
      return {
        cep: cleanCep,
        logradouro: field("logradouro"),
        bairro: field("bairro"),
        localidade: field("localidade"),
        uf: field("uf").toUpperCase(),
        complemento: field("complemento"),
      };
    } catch (error) {
      this.logger.error("Falha ao consultar ViaCEP", error);
      return null;
    }
  }
}
