import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
    const cleanCep = cep.replace(/\D/g, "");

    if (cleanCep.length !== 8) {
      return null;
    }

    const baseUrl =
      this.configService.get<string>("VIACEP_BASE_URL") ||
      "https://viacep.com.br/ws";
    const url = `${baseUrl}/${cleanCep}/json/`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        this.logger.warn(
          `ViaCEP respondeu ${response.status} para ${cleanCep}`,
        );
        return null;
      }

      const data = (await response.json()) as ViaCepAddress;
      return data.erro ? null : data;
    } catch (error) {
      this.logger.error("Falha ao consultar ViaCEP", error);
      return null;
    }
  }
}
