import { Injectable, Logger } from "@nestjs/common";
import { Conversation, ConversationState, Prisma } from "@prisma/client";
import { AiService } from "../ai/ai.service";
import {
  BulaApiService,
  CommercialMedicineOption,
  MedicineQuestion,
} from "../integrations/bula-api.service";
import { ViaCepAddress, ViaCepService } from "../integrations/via-cep.service";
import { PrismaService } from "../prisma/prisma.service";

interface CartItem {
  medicineName: string;
  name: string;
  form: string;
  dosage?: string;
  packageInfo?: string;
  unitPrice?: number;
  quantity: number;
  total?: number;
}

interface PendingAddress extends ViaCepAddress {
  number?: string;
}

@Injectable()
export class ConversationEngineService {
  private readonly logger = new Logger(ConversationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly bulaApiService: BulaApiService,
    private readonly viaCepService: ViaCepService,
  ) {}

  async resolveReply(conversation: Conversation, text: string) {
    this.logger.log(`Mensagem recebida: ${text}`);
    this.logger.log(`Estado atual: ${conversation.pendingAction}`);

    if (this.isResetCommand(text)) {
      await this.resetConversationContext(conversation.id);
      return "Conversa reiniciada. Como posso ajudar você hoje?";
    }

    if (this.isGlobalCancelRequest(text)) {
      await this.resetConversationContext(conversation.id);
      return "Atendimento cancelado. Se precisar, e so me chamar por aqui.";
    }

    const medicineQuestion = this.bulaApiService.detectMedicineQuestion(text);
    const extractedMedicine = this.bulaApiService.extractMedicineName(text);
    this.logger.log(
      `Intencao detectada: ${medicineQuestion?.intent || "UNKNOWN"}`,
    );
    this.logger.log(`Medicamento extraido: ${extractedMedicine || "nenhum"}`);

    if (this.isAddMoreRequest(text)) {
      this.logger.log("Carrinho mantido para adicionar mais itens");
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "ADD_ITEM",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: null,
          candidateOptions: Prisma.JsonNull,
          selectedPresentation: Prisma.JsonNull,
        },
      });

      return "Claro. Qual outro medicamento você deseja adicionar?";
    }

    const selectedOption = this.getSelectedOption(conversation);

    if (selectedOption && this.isCurrentItemQuestion(text)) {
      this.logger.log(
        `Pergunta detectada durante estado ${conversation.pendingAction}: ${text}`,
      );
      return this.answerCurrentItemQuestion(
        selectedOption,
        text,
        conversation.pendingAction,
      );
    }

    if (
      selectedOption &&
      this.isPriceQuestion(text) &&
      !this.bulaApiService.extractMedicineName(text)
    ) {
      return this.answerCurrentItemPrice(selectedOption, conversation.pendingAction);
    }

    if (this.shouldChangeOption(text, conversation)) {
      const changed = await this.changeSelectedOption(conversation, text);

      if (changed) {
        return changed;
      }
    }

    if (
      medicineQuestion &&
      this.hasExplicitMedicineSearchIntent(text) &&
      conversation.pendingAction !== ConversationState.WAITING_MEDICINE_NAME
    ) {
      return this.handleMedicineQuestion(conversation.id, medicineQuestion);
    }

    switch (conversation.pendingAction) {
      case ConversationState.WAITING_MEDICINE_NAME:
        return this.handleWaitingMedicineName(conversation, text, medicineQuestion);
      case ConversationState.WAITING_PRESENTATION:
        return this.handleWaitingPresentation(conversation, text, medicineQuestion);
      case ConversationState.WAITING_QUANTITY:
        return this.handleWaitingQuantity(conversation, text);
      case ConversationState.WAITING_CEP:
        return this.handleWaitingCep(conversation, text);
      case ConversationState.WAITING_ADDRESS_NUMBER:
        return this.handleWaitingAddressNumber(conversation, text);
      case ConversationState.WAITING_CONFIRMATION:
        return this.handleWaitingConfirmation(conversation, text);
      case ConversationState.WAITING_PIX:
        return "O Pix esta sendo preparado. Se quiser reiniciar o atendimento, envie reset.";
      case ConversationState.IDLE:
      default:
        return this.handleIdle(conversation, text, medicineQuestion);
    }
  }

  private async handleIdle(
    conversation: Conversation,
    text: string,
    medicineQuestion: MedicineQuestion | null,
  ) {
    if (this.bulaApiService.isPriceQuestionWithoutMedicine(text)) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "PRICE_REQUEST",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return "Qual produto você deseja consultar?";
    }

    if (medicineQuestion) {
      return this.handleMedicineQuestion(conversation.id, medicineQuestion);
    }

    return this.aiService.generatePharmacyReply(text);
  }

  private async handleWaitingMedicineName(
    conversation: Conversation,
    text: string,
    medicineQuestion: MedicineQuestion | null,
  ) {
    if (medicineQuestion) {
      return this.handleMedicineQuestion(conversation.id, {
        ...medicineQuestion,
        intent:
          conversation.lastIntent === "PRICE_REQUEST"
            ? "price"
            : medicineQuestion.intent,
      });
    }

    return "Qual medicamento você deseja consultar?";
  }

  private async handleWaitingPresentation(
    conversation: Conversation,
    text: string,
    medicineQuestion: MedicineQuestion | null,
  ) {
    if (medicineQuestion && this.hasExplicitMedicineSearchIntent(text)) {
      return this.handleMedicineQuestion(conversation.id, medicineQuestion);
    }

    const selectedOption = await this.selectCandidateOption(conversation, text);

    if (!selectedOption) {
      return "Nao consegui identificar a opcao. Responda com o numero da opcao ou diga comprimido, gotas, capsula ou xarope.";
    }

    await this.saveSelectedOption(conversation.id, selectedOption);
    return this.bulaApiService.formatSelectedOptionReply(selectedOption);
  }

  private async handleWaitingQuantity(conversation: Conversation, text: string) {
    const quantity = this.extractQuantity(text);

    if (!quantity) {
      return "Quantas unidades você deseja? Pode responder apenas com o numero.";
    }

    const selectedOption = this.getSelectedOption(conversation);

    if (!selectedOption) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });
      return "Perdi a opcao selecionada. Qual medicamento você deseja adicionar?";
    }

    const cart = this.getCart(conversation.cart);
    const item = this.buildCartItem(selectedOption, quantity);
    cart.push(item);
    this.logger.log(`Item adicionado ao carrinho: ${item.name}`);
    this.logger.log(`Carrinho atual: ${JSON.stringify(cart)}`);

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        cart: this.toJson(cart),
        pendingAction: ConversationState.WAITING_CEP,
      },
    });

    return [
      "Adicionei ao carrinho:",
      item.name,
      `Quantidade: ${quantity}`,
      item.total !== undefined
        ? `Subtotal: ${this.formatCurrency(item.total)}`
        : "Subtotal: preco nao encontrado",
      "",
      "Deseja adicionar mais algum medicamento ou calcular a entrega?",
    ].join("\n");
  }

  private async handleWaitingCep(conversation: Conversation, text: string) {
    if (this.isDeliveryRequest(text)) {
      return "Perfeito. Qual o CEP para entrega?";
    }

    const cep = this.extractCep(text);

    if (!cep) {
      if (this.isCurrentItemQuestion(text) || this.isPriceQuestion(text)) {
        const selectedOption = this.getSelectedOption(conversation);
        return selectedOption
          ? this.answerCurrentItemQuestion(
              selectedOption,
              text,
              ConversationState.WAITING_CEP,
            )
          : "Agora me envie o CEP para entrega.";
      }

      return "Agora me envie o CEP para entrega. Pode mandar apenas os 8 digitos.";
    }

    const address = await this.viaCepService.findAddressByCep(cep);

    if (!address) {
      return "Nao consegui localizar esse CEP. Pode conferir e enviar novamente?";
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_ADDRESS_NUMBER,
        pendingAddress: this.toJson(address),
      },
    });

    return `Encontrei: ${address.logradouro}, ${address.bairro}, ${address.localidade}-${address.uf}.\nQual o numero do endereco?`;
  }

  private async handleWaitingAddressNumber(
    conversation: Conversation,
    text: string,
  ) {
    const number = text.trim();

    if (!/\d+[a-zA-Z]?/.test(number)) {
      return "Qual o numero do endereco?";
    }

    const pendingAddress = this.getPendingAddress(conversation.pendingAddress);

    if (!pendingAddress) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CEP },
      });
      return "Nao encontrei o endereco anterior. Pode enviar o CEP novamente?";
    }

    const address = { ...pendingAddress, number };
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_CONFIRMATION,
        pendingAddress: this.toJson(address),
      },
    });

    return this.formatOrderConfirmation(conversation, address);
  }

  private async handleWaitingConfirmation(
    conversation: Conversation,
    text: string,
  ) {
    if (this.isAddMoreRequest(text)) {
      this.logger.log("Carrinho mantido para adicionar mais itens");
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "ADD_ITEM",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        },
      });

      return "Claro. Qual outro medicamento você deseja adicionar?";
    }

    if (this.isPositiveConfirmation(text)) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_PIX },
      });

      return "Pedido confirmado. Vou preparar o Pix para pagamento e te aviso por aqui.";
    }

    if (this.isGlobalCancelRequest(text)) {
      await this.resetConversationContext(conversation.id);
      return "Pedido cancelado. Se quiser recomecar, me diga o medicamento.";
    }

    return "Confirma o pedido? Responda SIM para gerar o Pix ou ADICIONAR para incluir mais produtos.";
  }

  private async handleMedicineQuestion(
    conversationId: string,
    question: MedicineQuestion,
  ) {
    const medicineName =
      this.bulaApiService.normalizeMedicineName(question.medicineName) ||
      question.medicineName;
    this.logger.log(`Nova busca de medicamento: ${medicineName}`);

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        currentMedicineQuery: medicineName,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
      },
    });
    this.logger.log("Contexto anterior limpo");

    const summary = await this.bulaApiService.lookupMedicine(medicineName);

    if (!summary) {
      return this.aiService.generatePharmacyReply(medicineName);
    }

    if (summary.products.length === 0 || summary.options.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: question.intent.toUpperCase(),
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          lastMedicine: medicineName,
          currentMedicineQuery: medicineName,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });
      return this.bulaApiService.formatNotFound(medicineName);
    }

    const shouldAskQuantity = summary.options.length === 1;
    const selectedOption = shouldAskQuantity
      ? await this.bulaApiService.priceSelectedOption(summary.options[0])
      : null;

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastIntent: question.intent.toUpperCase(),
        pendingAction: shouldAskQuantity
          ? ConversationState.WAITING_QUANTITY
          : ConversationState.WAITING_PRESENTATION,
        lastMedicine: medicineName,
        currentMedicineQuery: medicineName,
        candidateOptions: this.toJson(summary.options),
        selectedPresentation: selectedOption
          ? this.toJson(selectedOption)
          : Prisma.JsonNull,
      },
    });

    if (selectedOption) {
      return this.bulaApiService.formatSelectedOptionReply(selectedOption);
    }

    return question.intent === "price"
      ? this.bulaApiService.formatPriceReply(summary)
      : this.bulaApiService.formatPresentationChoiceReply(summary);
  }

  private async changeSelectedOption(conversation: Conversation, text: string) {
    const selectedOption = await this.selectCandidateOption(conversation, text);

    if (!selectedOption) {
      return null;
    }

    await this.saveSelectedOption(conversation.id, selectedOption);

    return [
      `Sem problema, alterei para ${selectedOption.label}.`,
      selectedOption.packageDescription
        ? `Embalagem: ${selectedOption.packageDescription}.`
        : null,
      selectedOption.pricePf
        ? `Valor: ${this.formatCurrency(selectedOption.pricePf)}.`
        : "Nao encontrei preco regulado para essa apresentacao.",
      "",
      "Quantas unidades você deseja?",
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  private async selectCandidateOption(conversation: Conversation, text: string) {
    const currentMedicineQuery =
      conversation.currentMedicineQuery || conversation.lastMedicine;
    const options = this.getCandidateOptions(conversation.candidateOptions)
      .filter((option) =>
        this.bulaApiService.optionBelongsToMedicine(
          currentMedicineQuery,
          option,
        ),
      );
    const explicitOption = this.findOptionByNumber(text, options);
    const option =
      explicitOption || this.bulaApiService.findOptionByReply(text, options);

    if (!option) {
      return null;
    }

    const pricedOption = await this.bulaApiService.priceSelectedOption(option);
    this.logger.log(`Opcao escolhida: ${pricedOption.label}`);
    return pricedOption;
  }

  private async saveSelectedOption(
    conversationId: string,
    selectedOption: CommercialMedicineOption,
  ) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        selectedPresentation: this.toJson(selectedOption),
        pendingAction: ConversationState.WAITING_QUANTITY,
      },
    });
  }

  private answerCurrentItemQuestion(
    option: CommercialMedicineOption,
    text: string,
    state: ConversationState,
  ) {
    const normalized = this.normalize(text);
    let answer = "";

    if (this.isPriceQuestion(text)) {
      answer = option.pricePf
        ? `O valor é ${this.formatCurrency(option.pricePf)}.`
        : "Nao encontrei preco regulado para essa apresentacao.";
    } else if (
      /\b(quantos|vem quantos|qual embalagem|embalagem)\b/.test(normalized)
    ) {
      answer = option.packageDescription
        ? `A embalagem selecionada vem com ${option.packageDescription.replace(/^caixa com\s+/i, "")}.`
        : "Nao encontrei a embalagem detalhada dessa apresentacao.";
    } else if (
      /\b(comprimido|comprimidos|capsula|capsulas|gotas)\b/.test(normalized)
    ) {
      answer = `A apresentacao selecionada é ${option.formGroup}.`;
    } else {
      answer = option.packageDescription
        ? `A embalagem selecionada vem com ${option.packageDescription.replace(/^caixa com\s+/i, "")}.`
        : "Nao encontrei a embalagem detalhada dessa apresentacao.";
    }

    return [answer, "", this.repeatStatePrompt(state)].join("\n");
  }

  private answerCurrentItemPrice(
    option: CommercialMedicineOption,
    state: ConversationState,
  ) {
    const answer = option.pricePf
      ? `O valor é ${this.formatCurrency(option.pricePf)}.`
      : "Nao encontrei preco regulado para essa apresentacao.";

    return [answer, "", this.repeatStatePrompt(state)].join("\n");
  }

  private formatOrderConfirmation(
    conversation: Conversation,
    address: PendingAddress,
  ) {
    const cart = this.getCart(conversation.cart);
    const subtotal = this.cartSubtotal(cart);
    const deadline = this.isCapital(address.localidade)
      ? "até 30 minutos"
      : "até 1 hora";

    return [
      "Resumo do pedido:",
      this.formatCartLines(cart),
      "",
      "Entrega:",
      `${address.logradouro}, numero ${address.number}, ${address.bairro}, ${address.localidade}/${address.uf}`,
      `Prazo estimado: ${deadline}`,
      "",
      `Total: ${this.formatCurrency(subtotal)}`,
      "",
      "Confirma o pedido? Responda SIM para gerar o Pix ou ADICIONAR para incluir mais produtos.",
    ].join("\n");
  }

  private buildCartItem(
    option: CommercialMedicineOption,
    quantity: number,
  ): CartItem {
    const total =
      option.pricePf !== undefined ? Number((option.pricePf * quantity).toFixed(2)) : undefined;

    return {
      medicineName: option.medicineName,
      name: option.label,
      form: option.formGroup,
      dosage: option.strength,
      packageInfo: option.packageDescription,
      unitPrice: option.pricePf,
      quantity,
      total,
    };
  }

  private formatCartLines(cart: CartItem[]) {
    if (cart.length === 0) {
      return "Nenhum item no carrinho.";
    }

    return cart
      .map((item, index) => {
        const packageText = item.packageInfo ? ` - ${item.packageInfo}` : "";
        const total =
          item.total !== undefined
            ? this.formatCurrency(item.total)
            : "preco nao encontrado";
        return `${index + 1}. ${item.name}${packageText}\nQuantidade: ${item.quantity}\nValor: ${total}`;
      })
      .join("\n\n");
  }

  private cartSubtotal(cart: CartItem[]) {
    return cart.reduce((sum, item) => sum + (item.total || 0), 0);
  }

  private getCandidateOptions(value: unknown): CommercialMedicineOption[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((option): option is CommercialMedicineOption => {
      return (
        typeof option === "object" &&
        option !== null &&
        "optionId" in option &&
        "label" in option
      );
    });
  }

  private getSelectedOption(
    conversation: Conversation,
  ): CommercialMedicineOption | null {
    const value = conversation.selectedPresentation;

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    if ("optionId" in value && "label" in value) {
      return value as unknown as CommercialMedicineOption;
    }

    return null;
  }

  private getCart(value: unknown): CartItem[] {
    return Array.isArray(value) ? (value as CartItem[]) : [];
  }

  private getPendingAddress(value: unknown): PendingAddress | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    return value as PendingAddress;
  }

  private extractQuantity(text: string) {
    const normalized = this.normalize(text);
    const words: Record<string, number> = {
      uma: 1,
      um: 1,
      duas: 2,
      dois: 2,
      tres: 3,
      quatro: 4,
      cinco: 5,
    };
    const numberMatch = normalized.match(/\d+/);

    if (numberMatch) {
      const quantity = Number(numberMatch[0]);
      return quantity > 0 ? quantity : null;
    }

    for (const [word, quantity] of Object.entries(words)) {
      if (new RegExp(`\\b${word}\\b`).test(normalized)) {
        return quantity;
      }
    }

    return null;
  }

  private extractCep(text: string) {
    const digits = text.replace(/\D/g, "");
    return digits.length === 8 ? digits : null;
  }

  private findOptionByNumber(
    text: string,
    options: CommercialMedicineOption[],
  ) {
    const match = this.normalize(text).match(
      /(?:^|\b)(?:opcao\s*)?(?:o\s*)?(\d+)(?:\b|$)/,
    );
    const optionId = match ? Number(match[1]) : null;
    return optionId ? options.find((option) => option.optionId === optionId) || null : null;
  }

  private repeatStatePrompt(state: ConversationState) {
    if (state === ConversationState.WAITING_QUANTITY) {
      return "Quantas unidades você deseja?";
    }

    if (state === ConversationState.WAITING_CEP) {
      return "Agora me envie o CEP para entrega.";
    }

    if (state === ConversationState.WAITING_CONFIRMATION) {
      return "Confirma o pedido? Responda SIM para gerar o Pix ou ADICIONAR para incluir mais produtos.";
    }

    return "Como posso ajudar?";
  }

  private async resetConversationContext(conversationId: string) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastIntent: null,
        pendingAction: ConversationState.IDLE,
        lastMedicine: null,
        currentMedicineQuery: null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
        cart: Prisma.JsonNull,
        pendingAddress: Prisma.JsonNull,
      },
    });
  }

  private shouldChangeOption(text: string, conversation: Conversation) {
    if (!conversation.candidateOptions) {
      return false;
    }

    if (conversation.pendingAction === ConversationState.WAITING_PRESENTATION) {
      return false;
    }

    const normalized = this.normalize(text);
    return (
      /\b(quero|prefiro|muda|troca|opcao|na verdade)\b/.test(normalized) &&
      (/\d+/.test(normalized) ||
        /\b(500mg|500|1g|400mg|400|600mg|600|gotas|comprimido|capsula)\b/.test(
          normalized,
        ))
    );
  }

  private isCurrentItemQuestion(text: string) {
    const normalized = this.normalize(text);
    return /\b(quantos|vem quantos|qual embalagem|embalagem|e comprimido|e gotas|qual valor mesmo)\b/.test(
      normalized,
    );
  }

  private isPriceQuestion(text: string) {
    const normalized = this.normalize(text);
    return /\b(qual valor|quanto custa|preco|valor)\b/.test(normalized);
  }

  private isResetCommand(text: string) {
    const normalized = this.normalize(text).trim();
    return (
      normalized === "reset" ||
      normalized === "/reset" ||
      normalized === "recomecar"
    );
  }

  private isGlobalCancelRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(cancelar|desistir|nao quero mais|cancela)$/.test(normalized);
  }

  private hasExplicitMedicineSearchIntent(text: string) {
    const normalized = this.normalize(text);
    return /\b(tem|teria|vende|vendem|quero|queria|preciso|gostaria|adicionar|preco|valor|quanto custa)\b/.test(
      normalized,
    );
  }

  private isAddMoreRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(mais remedio|mais remedios|adicionar outro|adicionar|quero mais|sim quero mais|gostaria de mais|outro produto|mais um produto|mais um)\b/.test(
      normalized,
    );
  }

  private isDeliveryRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(calcular entrega|entrega|finalizar|nao|não)$/.test(normalized);
  }

  private isPositiveConfirmation(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(sim|confirmo|pode confirmar|confirmar|ok|fechado)\b/.test(
      normalized,
    );
  }

  private isCapital(city?: string) {
    const normalized = this.normalize(city || "");
    return [
      "rio de janeiro",
      "sao paulo",
      "belo horizonte",
      "curitiba",
      "salvador",
      "fortaleza",
      "recife",
      "porto alegre",
      "brasilia",
      "manaus",
      "belem",
      "goiania",
    ].includes(normalized);
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private formatCurrency(value: number | undefined) {
    if (value === undefined) {
      return "";
    }

    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
