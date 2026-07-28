import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly openai?: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>("OPENAI_API_KEY");

    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async generatePharmacyReply(customerMessage: string) {
    if (!this.openai) {
      return this.defaultReply();
    }

    try {
      const model =
        this.configService.get<string>("OPENAI_MODEL") || "gpt-4o-mini";

      const completion = await this.openai.chat.completions.create({
        model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "Você é um assistente de atendimento de farmácia no WhatsApp. Responda em português do Brasil, seja breve, acolhedor e não substitua orientação médica. Quando houver risco, alergia, gestação, crianças, interações medicamentosas ou sintomas graves, oriente procurar farmacêutico ou médico.",
          },
          {
            role: "user",
            content: customerMessage,
          },
        ],
      });

      return (
        completion.choices[0]?.message?.content?.trim() || this.defaultReply()
      );
    } catch (error) {
      this.logger.error("Falha ao gerar resposta com OpenAI", error);
      return this.defaultReply();
    }
  }

  async extractMedicineFromPackageImage(image: Buffer, mimeType: string) {
    if (!this.openai) {
      return null;
    }

    try {
      const model =
        this.configService.get<string>("OPENAI_VISION_MODEL") ||
        this.configService.get<string>("OPENAI_MODEL") ||
        "gpt-4o-mini";
      const base64 = image.toString("base64");

      const completion = await this.openai.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Você extrai informações de fotos de embalagens de farmácia. Responda somente em JSON válido com os campos medicineName, dosage, form e confidence. Se não conseguir identificar, use null nos campos e confidence 0.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Identifique o medicamento ou produto principal desta embalagem.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                },
              },
            ],
          },
        ],
      });

      const content = completion.choices[0]?.message?.content?.trim();

      if (!content) {
        return null;
      }

      return JSON.parse(content) as {
        medicineName?: string | null;
        dosage?: string | null;
        form?: string | null;
        confidence?: number;
      };
    } catch (error) {
      this.logger.error("Falha ao analisar foto da embalagem", error);
      return null;
    }
  }

  private defaultReply() {
    return "Oi! Recebi sua mensagem. Um atendente da farmácia vai te ajudar por aqui em instantes. Se for urgente ou envolver reação alérgica, procure atendimento médico imediatamente.";
  }
}
