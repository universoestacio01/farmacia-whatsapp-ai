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
              "Voce e um assistente de atendimento de farmacia no WhatsApp. Responda em portugues do Brasil, seja breve, acolhedor e nao substitua orientacao medica. Quando houver risco, alergia, gestacao, criancas, interacoes medicamentosas ou sintomas graves, oriente procurar farmaceutico ou medico.",
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

  private defaultReply() {
    return "Oi! Recebi sua mensagem. Um atendente da farmacia vai te ajudar por aqui em instantes. Se for urgente ou envolver reacao alergica, procure atendimento medico imediatamente.";
  }
}
