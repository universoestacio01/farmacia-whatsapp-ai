import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiService } from "../ai/ai.service";

interface WhatsappMediaMetadata {
  url?: string;
  mime_type?: string;
}

@Injectable()
export class WhatsappMediaService {
  private readonly logger = new Logger(WhatsappMediaService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly aiService: AiService,
  ) {}

  async extractMedicineFromImage(mediaId: string, fallbackMimeType?: string) {
    try {
      const media = await this.downloadMedia(mediaId);
      const analysis = await this.aiService.extractMedicineFromPackageImage(
        media.buffer,
        media.mimeType || fallbackMimeType || "image/jpeg",
      );

      if (!analysis?.medicineName || (analysis.confidence ?? 0) < 0.45) {
        return null;
      }

      return [analysis.medicineName, analysis.dosage, analysis.form]
        .filter(Boolean)
        .join(" ");
    } catch (error) {
      this.logger.warn(
        `Falha ao interpretar imagem do WhatsApp: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      return null;
    }
  }

  private async downloadMedia(mediaId: string) {
    const accessToken = this.configService.get<string>("WHATSAPP_ACCESS_TOKEN");
    const apiVersion =
      this.configService.get<string>("WHATSAPP_API_VERSION") || "v25.0";

    if (!accessToken) {
      throw new Error("WHATSAPP_ACCESS_TOKEN ausente para baixar mídia.");
    }

    const metadataResponse = await fetch(
      `https://graph.facebook.com/${apiVersion}/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!metadataResponse.ok) {
      throw new Error(`Falha ao buscar metadata da mídia: ${metadataResponse.status}`);
    }

    const metadata = (await metadataResponse.json()) as WhatsappMediaMetadata;

    if (!metadata.url) {
      throw new Error("WhatsApp não retornou URL da mídia.");
    }

    const mediaResponse = await fetch(metadata.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!mediaResponse.ok) {
      throw new Error(`Falha ao baixar mídia: ${mediaResponse.status}`);
    }

    return {
      buffer: Buffer.from(await mediaResponse.arrayBuffer()),
      mimeType: metadata.mime_type,
    };
  }
}
