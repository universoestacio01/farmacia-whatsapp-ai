import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface MedicineSearchResult {
  nomeProduto?: string;
  expediente?: string;
  razaoSocial?: string;
  cnpj?: string;
}

@Injectable()
export class BulaApiService {
  private readonly logger = new Logger(BulaApiService.name);

  constructor(private readonly configService: ConfigService) {}

  async searchMedicine(term: string): Promise<MedicineSearchResult[]> {
    const baseUrl =
      this.configService.get<string>("BULA_API_BASE_URL") ||
      "https://bula.vercel.app";
    const url = `${baseUrl}/pesquisar?nome=${encodeURIComponent(term)}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        this.logger.warn(`BulaAPI respondeu ${response.status} para ${term}`);
        return [];
      }

      const data = (await response.json()) as {
        content?: MedicineSearchResult[];
      };
      return data.content || [];
    } catch (error) {
      this.logger.error("Falha ao consultar BulaAPI", error);
      return [];
    }
  }
}
