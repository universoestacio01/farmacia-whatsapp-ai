import { Injectable, Logger } from "@nestjs/common";
import { Conversation, ConversationState, Prisma } from "@prisma/client";
import { AiService } from "../ai/ai.service";
import {
  BulaApiService,
  CommercialMedicineOption,
  MedicineQuestion,
} from "../integrations/bula-api.service";
import { MedicineSearchOrchestratorService } from "../integrations/medicine-search-orchestrator.service";
import {
  ProductSearchOrchestratorService,
  RetailProductLookupSummary,
} from "../integrations/product-search-orchestrator.service";
import { ViaCepAddress, ViaCepService } from "../integrations/via-cep.service";
import { PaymentsService } from "../payments/payments.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  choicePrompt,
  formatProductDisplayName,
  sanitizeCustomerText,
  WhatsappCopy,
} from "./whatsapp-copy";

interface CartItem {
  type: "medicine" | "retail_product";
  medicineName: string;
  name: string;
  brand?: string;
  form: string;
  presentation?: string;
  description?: string;
  dosage?: string;
  packageInfo?: string;
  unitPrice?: number;
  quantity: number;
  total?: number;
  imageUrl?: string;
  source?: string;
}

interface PendingAddress extends ViaCepAddress {
  number?: string;
  addressComplement?: string | null;
  addressReference?: string | null;
}

type CommercialSelectionMode =
  | "recommended"
  | "cheapest"
  | "generic"
  | "larger"
  | "smaller";

@Injectable()
export class ConversationEngineService {
  private readonly logger = new Logger(ConversationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly bulaApiService: BulaApiService,
    private readonly medicineSearch: MedicineSearchOrchestratorService,
    private readonly productSearch: ProductSearchOrchestratorService,
    private readonly viaCepService: ViaCepService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async resolveReply(conversation: Conversation, text: string) {
    this.logger.log(`Mensagem recebida: ${text}`);
    this.logger.log(`Estado atual: ${conversation.pendingAction}`);

    if (this.isResetCommand(text)) {
      await this.resetConversationContext(conversation.id);
      return WhatsappCopy.resetConversation();
    }

    const medicineQuestion = this.bulaApiService.detectMedicineQuestion(text);
    const extractedMedicine = this.bulaApiService.extractMedicineName(text);
    const retailProductQuery = this.productSearch.isRetailProductQuery(text);
    this.logger.log(
      `Intencao detectada: ${medicineQuestion?.intent || "nenhuma"}`,
    );
    this.logger.log(`Medicamento extraido: ${extractedMedicine || "nenhum"}`);

    if (conversation.lastIntent === "WAITING_REMOVE_ITEM") {
      return this.handlePendingRemoveItem(conversation, text);
    }

    if (conversation.lastIntent === "WAITING_CANCEL_CART") {
      return this.handlePendingCancelCart(conversation, text);
    }

    if (this.isGlobalCancelRequest(text)) {
      return this.handleGlobalCancel(conversation);
    }

    if (this.isBackRequest(text)) {
      return this.handleBackRequest(conversation);
    }

    if (this.isRemoveItemRequest(text)) {
      return this.handleRemoveItemRequest(conversation, text);
    }

    if (this.isSwapCartItemRequest(text)) {
      return this.handleSwapCartItemRequest(conversation, text);
    }

    if (this.isViewCartRequest(text)) {
      return this.formatCartStatus(conversation);
    }

    if (this.isDeliveryPriceQuestion(text)) {
      return this.formatFreeDeliveryReply();
    }

    if (this.isPaymentCommand(text)) {
      return this.handlePaymentCommand(conversation, text);
    }

    if (this.isFinalizeRequest(text)) {
      return this.handleFinalizeRequest(conversation);
    }

    if (this.isAddMoreRequest(text)) {
      this.logger.log("Carrinho mantido para adicionar mais itens");
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "ADD_ITEM",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          candidateOptions: Prisma.JsonNull,
          selectedPresentation: Prisma.JsonNull,
        },
      });

      return "Claro 😊 Qual outro produto você quer adicionar?";
    }

    if (
      this.isCheapestRequest(text) ||
      this.isRecommendationRequest(text) ||
      this.isGenericRequest(text) ||
      this.isLargerRequest(text) ||
      this.isSmallerRequest(text)
    ) {
      const selected = await this.selectRecommendedCandidate(
        conversation,
        this.getCommercialSelectionMode(text),
      );

      if (!selected.startsWith("No momento não encontrei")) {
        return selected;
      }
    }

    if (this.isMoreOptionsRequest(text)) {
      return this.handleMoreOptionsRequest(conversation);
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
      retailProductQuery &&
      this.hasExplicitMedicineSearchIntent(text) &&
      conversation.pendingAction !== ConversationState.WAITING_MEDICINE_NAME
    ) {
      return this.handleRetailProductQuestion(conversation.id, text);
    }

    if (
      medicineQuestion &&
      this.hasExplicitMedicineSearchIntent(text) &&
      conversation.pendingAction !== ConversationState.WAITING_MEDICINE_NAME
    ) {
      return this.handleMedicineQuestion(conversation.id, medicineQuestion);
    }

    const paymentStates: ConversationState[] = [ConversationState.WAITING_PIX];
    if (paymentStates.includes(conversation.pendingAction)) {
      return this.handleWaitingPix(conversation, text);
    }

    switch (conversation.pendingAction) {
      case ConversationState.WAITING_MEDICINE_NAME:
        return this.handleWaitingMedicineName(conversation, text, medicineQuestion);
      case ConversationState.WAITING_RETAIL_BRAND:
        return this.handleWaitingRetailBrand(conversation, text);
      case ConversationState.WAITING_PRESENTATION:
        return this.handleWaitingPresentation(conversation, text, medicineQuestion);
      case ConversationState.WAITING_QUANTITY:
        return this.handleWaitingQuantity(conversation, text);
      case ConversationState.WAITING_CEP:
        return this.handleWaitingCep(conversation, text);
      case ConversationState.WAITING_ADDRESS_NUMBER:
        return this.handleWaitingAddressNumber(conversation, text);
      case ConversationState.WAITING_ADDRESS_COMPLEMENT:
        return this.handleWaitingAddressComplement(conversation, text);
      case ConversationState.WAITING_CONFIRMATION:
        return this.handleWaitingConfirmation(conversation, text);
      case ConversationState.WAITING_PIX:
        return "O Pix está sendo preparado. Se quiser, envie “pix” para receber o código novamente.";
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
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return "Qual produto você quer consultar?";
    }

    const symptomReply = this.medicineSearch.findSymptomOptions(text);

    if (symptomReply) {
      return symptomReply;
    }

    if (this.productSearch.isRetailProductQuery(text)) {
      return this.handleRetailProductQuestion(conversation.id, text);
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
    if (this.productSearch.isRetailProductQuery(text)) {
      return this.handleRetailProductQuestion(conversation.id, text);
    }

    if (medicineQuestion) {
      return this.handleMedicineQuestion(conversation.id, {
        ...medicineQuestion,
        intent:
          conversation.lastIntent === "PRICE_REQUEST"
            ? "price"
            : medicineQuestion.intent,
      });
    }

    return "Qual medicamento você quer consultar?";
  }

  private async handleWaitingRetailBrand(conversation: Conversation, text: string) {
    const category = conversation.currentRetailCategory;

    if (!category) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.IDLE },
      });

      return "Qual produto você quer consultar?";
    }

    if (
      conversation.lastIntent === "RETAIL_SIMILARS" &&
      this.isNegativeReply(text)
    ) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentRetailCategory: null,
        },
      });

      return "Tudo bem. Qual outro produto você quer consultar?";
    }

    if (conversation.lastIntent === "WAITING_DIAPER_SIZE") {
      return this.handleRetailAttributeSelection(conversation, text, "tamanho");
    }

    if (conversation.lastIntent === "WAITING_SUNSCREEN_FPS") {
      return this.handleRetailAttributeSelection(conversation, text, "FPS");
    }

    if (this.isRecommendationRequest(text) || this.isCheapestRequest(text)) {
      return this.handleRetailProductQuestion(conversation.id, category, {
        category,
        selectedBrand: "qualquer marca",
        preferCheapest: this.isCheapestRequest(text),
      });
    }

    const selectedBrand =
      conversation.lastIntent === "RETAIL_SIMILARS" &&
      (this.isPositiveConfirmation(text) || this.isConfirmChoice(text))
        ? "qualquer marca"
        : this.productSearch.resolveBrandSelection(category, text);

    if (!selectedBrand) {
      return this.formatRetailBrandPrompt(category);
    }

    this.logger.log(`RETAIL BRAND SELECTED: ${selectedBrand}`);
    const query = this.productSearch.buildQueryFromBrandSelection(
      category,
      selectedBrand,
    );

    return this.handleRetailProductQuestion(conversation.id, query, {
      category,
      selectedBrand,
    });
  }

  private async handleMoreOptionsRequest(conversation: Conversation) {
    const options = this.getCandidateOptions(conversation.candidateOptions);
    const hasMedicineOptions = options.some(
      (option) => option.type !== "retail_product",
    );

    if (hasMedicineOptions) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingAction: ConversationState.WAITING_PRESENTATION,
          selectedPresentation: Prisma.JsonNull,
        },
      });

      return [
        "Tenho estas opções disponíveis:",
        "",
        this.formatCandidateOptions(options),
        "",
        choicePrompt(),
      ].join("\n");
    }

    const selectedOption = this.getSelectedOption(conversation);
    const category =
      conversation.currentRetailCategory ||
      (selectedOption?.type === "retail_product"
        ? selectedOption.medicineName
        : null);

    if (!category) {
      return "Claro, vou te mostrar outras opções. Qual produto você quer ver?";
    }

    const brand = selectedOption?.brand || undefined;
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: "RETAIL_SIMILARS",
        pendingAction: ConversationState.WAITING_RETAIL_BRAND,
        currentRetailCategory: category,
      },
    });

    return [
      `Claro, vou te mostrar outras opções de ${formatProductDisplayName(category)}${brand ? ` ${formatProductDisplayName(brand)}` : ""}.`,
      "",
      WhatsappCopy.showSimilarOffer(category, brand),
    ].join("\n");
  }

  private async handleWaitingPresentation(
    conversation: Conversation,
    text: string,
    medicineQuestion: MedicineQuestion | null,
  ) {
    if (this.isRejectionRequest(text) || this.isOpenChangeRequest(text)) {
      return this.reopenCandidateOptions(conversation);
    }

    if (
      this.isRecommendationRequest(text) ||
      this.isCheapestRequest(text) ||
      this.isGenericRequest(text) ||
      this.isLargerRequest(text) ||
      this.isSmallerRequest(text)
    ) {
      return this.selectRecommendedCandidate(
        conversation,
        this.getCommercialSelectionMode(text),
      );
    }

    if (this.productSearch.isRetailProductQuery(text)) {
      return this.handleRetailProductQuestion(conversation.id, text);
    }

    if (medicineQuestion && this.hasExplicitMedicineSearchIntent(text)) {
      return this.handleMedicineQuestion(conversation.id, medicineQuestion);
    }

    const selectedOption = await this.selectCandidateOption(conversation, text);

    if (!selectedOption) {
      return "Não consegui identificar a opção. Digite o número ou me diga qual apresentação você quer levar.";
    }

    await this.saveSelectedOption(conversation.id, selectedOption);
    return this.formatSelectedOptionReply(selectedOption);
  }

  private async handleWaitingQuantity(conversation: Conversation, text: string) {
    if (this.isRejectionRequest(text) || this.isOpenChangeRequest(text)) {
      return this.reopenCandidateOptions(conversation);
    }

    const quantity = this.extractQuantity(text);

    if (!quantity) {
      return WhatsappCopy.askQuantity();
    }

    const selectedOption = this.getSelectedOption(conversation);

    if (!selectedOption) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });
      return "Não encontrei a opção selecionada. Qual produto você quer adicionar?";
    }

    const cart = this.getCart(conversation.cart);
    const item = this.buildCartItem(selectedOption, quantity);
    cart.push(item);
    this.logger.log(`Item adicionado ao carrinho: ${item.name}`);
    if (item.type === "retail_product") {
      this.logger.log(`RETAIL PRODUCT ADDED TO CART: ${item.name}`);
    }
    this.logger.log(`Carrinho atual: ${JSON.stringify(cart)}`);

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        cart: this.toJson(cart),
        pendingAction: ConversationState.WAITING_CEP,
      },
    });

    return WhatsappCopy.addedToCart(
      item,
      this.cartSubtotal(cart),
      this.formatCurrency.bind(this),
    );
  }

  private async handleWaitingCep(conversation: Conversation, text: string) {
    if (this.isRejectionRequest(text) || this.isOpenChangeRequest(text)) {
      return this.removeLastCartItemAndReopenOptions(conversation);
    }

    if (this.isAddMoreChoice(text)) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "ADD_ITEM",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return "Claro 😊 Qual produto você quer adicionar?";
    }

    if (this.isDeliveryPriceQuestion(text)) {
      return this.formatFreeDeliveryReply();
    }

    if (this.isDeliveryRequest(text)) {
      return WhatsappCopy.askCep();
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
          : WhatsappCopy.askCep();
      }

      return "Me envie o CEP da entrega, por favor. Pode mandar apenas os 8 dígitos.";
    }

    const address = await this.viaCepService.findAddressByCep(cep);

    if (!address) {
      return "Não consegui localizar esse CEP. Pode conferir e enviar novamente?";
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_ADDRESS_NUMBER,
        pendingAddress: this.toJson(address),
      },
    });

    return WhatsappCopy.askAddressNumber(
      `${address.logradouro}, ${address.bairro}, ${address.localidade}-${address.uf}`,
    );
  }

  private async handleWaitingAddressNumber(
    conversation: Conversation,
    text: string,
  ) {
    const number = text.trim();

    if (!this.isAddressNumber(number)) {
      return "Qual é o número do endereço?";
    }

    const pendingAddress = this.getPendingAddress(conversation.pendingAddress);

    if (!pendingAddress) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CEP },
      });
      return "Não encontrei o endereço anterior. Pode me enviar o CEP novamente?";
    }

    const address = { ...pendingAddress, number };
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_ADDRESS_COMPLEMENT,
        pendingAddress: this.toJson(address),
      },
    });

    return WhatsappCopy.askAddressComplement();
  }

  private async handleWaitingAddressComplement(
    conversation: Conversation,
    text: string,
  ) {
    const pendingAddress = this.getPendingAddress(conversation.pendingAddress);

    if (!pendingAddress?.number) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CEP },
      });
      return "Não encontrei o endereço anterior. Pode me enviar o CEP novamente?";
    }

    const address = {
      ...pendingAddress,
      ...this.parseAddressComplement(text),
    };

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
    if (this.isPositiveConfirmation(text) || this.isConfirmChoice(text)) {
      return this.confirmOrderAndCreatePayment(conversation);
    }

    if (this.isAddMoreRequest(text) || this.isAddMoreConfirmationChoice(text)) {
      this.logger.log("Carrinho mantido para adicionar mais itens");
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "ADD_ITEM",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return "Claro 😊 Qual outro produto você quer adicionar?";
    }

    if (this.isGlobalCancelRequest(text) || this.isCancelChoice(text)) {
      await this.resetConversationContext(conversation.id);
      return "Pedido cancelado. Se quiser recomeçar, é só me chamar por aqui.";
    }

    return "Confirma o pedido?\n\n1. Confirmar\n2. Adicionar mais produtos\n3. Cancelar";
  }

  private async confirmOrderAndCreatePayment(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });

      return "Seu carrinho ainda está vazio. Qual produto você quer pedir?";
    }

    const payment = await this.paymentsService.confirmCheckout({
      conversationId: conversation.id,
      customerId: conversation.customerId,
      cart,
      address: this.getPendingAddress(conversation.pendingAddress),
      existingOrderId: this.extractConfirmedOrderId(conversation.lastIntent),
    });

    try {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: `ORDER_CONFIRMED:${payment.orderId}`,
          pendingAction: ConversationState.WAITING_PIX,
        },
      });
    } catch (error) {
      this.logger.error(
        "CHECKOUT CONTEXT UPDATE FAILED AFTER PAYMENT CREATION",
        error instanceof Error ? error.stack : String(error),
      );
    }

    if (payment.pixCreationFailed || !payment.pixCopyPaste) {
      return this.formatPixFailureRetryReply();
    }

    return this.formatPixPaymentReply(
      payment.totalCents,
      payment.pixCopyPaste,
      payment.paymentUrl,
    );
  }

  private async handleWaitingPix(conversation: Conversation, text: string) {
    if (this.isPixRetryCommand(text)) {
      return this.confirmOrderAndCreatePayment(conversation);
    }

    if (this.isPixCancelChoice(text)) {
      await this.resetConversationContext(conversation.id);
      return "Pedido cancelado. Se quiser recomeçar, é só me chamar por aqui.";
    }

    if (this.isAlreadyPaidCommand(text)) {
      return this.formatWaitingPaymentConfirmationReply();
    }

    return this.handlePaymentCommand(conversation, text);
  }

  private async handlePaymentCommand(conversation: Conversation, text: string) {
    const order = await this.paymentsService.findLatestPaymentForCustomer(
      conversation.customerId,
    );
    const payment = order?.payments?.[0];

    if (!order) {
      return "Para gerar o Pix, finalize o carrinho primeiro.";
    }

    if (!payment) {
      return this.confirmOrderAndCreatePayment(conversation);
    }

    if (payment.status === "PAID") {
      return [
        "Pagamento confirmado ✅",
        "",
        "Seu pedido já está sendo separado.",
        "",
        "🚚 Entrega grátis por motoboy",
        "⏱️ Após a confirmação do pagamento, seu pedido chega em até 30 minutos.",
      ].join("\n");
    }

    if (this.isAlreadyPaidCommand(text)) {
      return this.formatWaitingPaymentConfirmationReply();
    }

    const pixCopyPaste = payment.pixCopyPaste || payment.pixPayload;

    if (payment.provider === "sigilopay" && pixCopyPaste) {
      return this.formatPixResendReply(pixCopyPaste);
    }

    return this.confirmOrderAndCreatePayment(conversation);
  }

  private formatPixPaymentReply(
    totalCents: number,
    pixCopyPaste: string,
    paymentUrl?: string,
  ) {
    const paymentInfo = [
      "✅ Pedido confirmado!",
      "",
      `Total: ${this.formatCurrency(totalCents / 100)}`,
      "",
      "Vou te enviar o Pix Copia e Cola na próxima mensagem.",
      "",
      "Basta tocar e copiar.",
    ].join("\n");

    const deliveryInfo = [
      "Após o pagamento, eu aviso você automaticamente por aqui.",
      "",
    ];

    if (paymentUrl) {
      deliveryInfo.push(
        "Se preferir, você também pode pagar por este link:",
        paymentUrl,
        "",
      );
    }

    deliveryInfo.push(
      "🚚 Entrega grátis por motoboy",
      "⏱️ Após a confirmação do pagamento, seu pedido chega em até 30 minutos.",
    );

    return [
      paymentInfo,
      this.normalizePixCopyPaste(pixCopyPaste),
      deliveryInfo.join("\n"),
    ];
  }

  private formatPixResendReply(pixCopyPaste: string) {
    return [
      [
        "Claro, vou reenviar o Pix Copia e Cola na próxima mensagem.",
        "",
        "Basta tocar e copiar.",
      ].join("\n"),
      this.normalizePixCopyPaste(pixCopyPaste),
      "Após o pagamento, eu aviso você automaticamente por aqui.",
    ];
  }

  private formatWaitingPaymentConfirmationReply() {
    return [
      "Perfeito 👍",
      "",
      "Estou aguardando a confirmação automática do pagamento.",
      "Assim que for confirmado, aviso você por aqui.",
    ].join("\n");
  }

  private formatPixFailureRetryReply() {
    return [
      "Não consegui gerar o Pix neste momento.",
      "",
      "Quer tentar novamente?",
      "",
      "1. Gerar Pix novamente",
      "2. Cancelar pedido",
    ].join("\n");
  }

  private extractConfirmedOrderId(lastIntent: string | null) {
    const match = lastIntent?.match(/^ORDER_CONFIRMED:(.+)$/);
    return match?.[1] || null;
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
        currentRetailCategory: null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
      },
    });
    this.logger.log("Contexto anterior limpo");

    const summary = await this.medicineSearch.searchMedicine(medicineName);

    if (!summary) {
      return this.aiService.generatePharmacyReply(medicineName);
    }

    if (this.isInformationalMedicineIntent(question.intent)) {
      return this.formatMedicineInformationReply(question, summary);
    }

    if (summary.options.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: question.intent.toUpperCase(),
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          lastMedicine: medicineName,
          currentMedicineQuery: medicineName,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });
      return WhatsappCopy.medicineNotFound();
    }

    const shouldAskQuantity = summary.options.length === 1;
    const selectedOption = shouldAskQuantity
      ? await this.ensureSelectedOptionPrice(summary.options[0])
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
        currentRetailCategory: null,
        candidateOptions: this.toJson(summary.options),
        selectedPresentation: selectedOption
          ? this.toJson(selectedOption)
          : Prisma.JsonNull,
      },
    });

    if (selectedOption) {
      return this.formatSelectedOptionReply(selectedOption);
    }

    return question.intent === "price"
      ? this.bulaApiService.formatPriceReply(summary)
      : this.bulaApiService.formatPresentationChoiceReply(summary);
  }

  private async handleRetailProductQuestion(
    conversationId: string,
    message: string,
    context?: {
      category?: string;
      selectedBrand?: string;
      preferCheapest?: boolean;
    },
  ) {
    const productQuery = this.extractRetailProductQuery(message);
    this.logger.log(`RETAIL PRODUCT QUERY: ${productQuery}`);
    const genericCategory =
      context?.category || this.productSearch.findGenericCategory(productQuery);
    const effectiveCategory =
      genericCategory || this.detectRetailCategoryFromQuery(productQuery);

    if (
      effectiveCategory === "fralda" &&
      !this.extractDiaperSize(productQuery) &&
      !context?.selectedBrand
    ) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: "WAITING_DIAPER_SIZE",
          pendingAction: ConversationState.WAITING_RETAIL_BRAND,
          currentMedicineQuery: productQuery,
          currentRetailCategory: effectiveCategory,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return "Claro. Qual tamanho de fralda você precisa? Pode responder P, M, G, XG ou XXG.";
    }

    if (
      effectiveCategory === "protetor solar" &&
      !this.extractSunscreenFps(productQuery) &&
      !context?.selectedBrand &&
      !this.isOnlyGenericRetailCategoryQuery(productQuery, effectiveCategory)
    ) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: "WAITING_SUNSCREEN_FPS",
          pendingAction: ConversationState.WAITING_RETAIL_BRAND,
          currentMedicineQuery: productQuery,
          currentRetailCategory: effectiveCategory,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return "Claro. Qual FPS você prefere? Pode responder 30, 50, 60 ou 70.";
    }

    if (
      effectiveCategory &&
      effectiveCategory !== "gillette" &&
      !context?.selectedBrand &&
      this.isOnlyGenericRetailCategoryQuery(productQuery, effectiveCategory)
    ) {
      this.logger.log("RETAIL GENERIC CATEGORY DETECTED");
      this.logger.log("WAITING RETAIL BRAND");

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: "RETAIL_PRODUCT",
          pendingAction: ConversationState.WAITING_RETAIL_BRAND,
          currentMedicineQuery: null,
          currentRetailCategory: effectiveCategory,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return this.formatRetailBrandPrompt(effectiveCategory);
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastIntent: "RETAIL_PRODUCT",
        currentMedicineQuery: productQuery,
        currentRetailCategory: effectiveCategory || null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
      },
    });
    this.logger.log("Contexto anterior limpo");

    const summary = await this.productSearch.searchProducts(productQuery);
    const orderedSummary = context?.preferCheapest
      ? this.sortSummaryByCheapest(summary)
      : summary;

    if (orderedSummary.options.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: "RETAIL_PRODUCT",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: productQuery,
          currentRetailCategory: orderedSummary.category || effectiveCategory || null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return WhatsappCopy.productNotFound(productQuery);
    }

    const shouldAskQuantity = orderedSummary.options.length === 1;
    const selectedOption = shouldAskQuantity ? orderedSummary.options[0] : null;

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastIntent: "RETAIL_PRODUCT",
        pendingAction: shouldAskQuantity
          ? ConversationState.WAITING_QUANTITY
          : ConversationState.WAITING_PRESENTATION,
        lastMedicine: productQuery,
        currentMedicineQuery: productQuery,
        currentRetailCategory: orderedSummary.category || effectiveCategory || null,
        candidateOptions: this.toJson(orderedSummary.options),
        selectedPresentation: selectedOption
          ? this.toJson(selectedOption)
          : Prisma.JsonNull,
      },
    });

    if (selectedOption) {
      this.logger.log(`RETAIL PRODUCT SELECTED: ${selectedOption.label}`);
      return this.formatSelectedOptionReply(selectedOption);
    }

    return this.formatRetailProductChoiceReply(orderedSummary);
  }

  private async handleRetailAttributeSelection(
    conversation: Conversation,
    text: string,
    attributeName: "tamanho" | "FPS",
  ) {
    const baseQuery =
      conversation.currentMedicineQuery || conversation.currentRetailCategory || "";
    const attributeValue =
      attributeName === "tamanho"
        ? this.extractDiaperSize(text)
        : this.extractSunscreenFps(text);

    if (!attributeValue) {
      return attributeName === "tamanho"
        ? "Qual tamanho de fralda você precisa? Pode responder P, M, G, XG ou XXG."
        : "Qual FPS você prefere? Pode responder 30, 50, 60 ou 70.";
    }

    const query = `${baseQuery} ${attributeName} ${attributeValue}`;
    return this.handleRetailProductQuestion(conversation.id, query, {
      category: conversation.currentRetailCategory || undefined,
      selectedBrand: "atributo confirmado",
    });
  }

  private async handleFinalizeRequest(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Qual produto você quer pedir?";
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { pendingAction: ConversationState.WAITING_CEP },
    });

    return [
      "Perfeito, vamos finalizar seu pedido.",
      "",
      this.formatCartStatus(conversation),
      "",
      "Me envie o CEP da entrega, por favor. Pode mandar apenas os 8 dígitos.",
    ].join("\n");
  }

  private formatCartStatus(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Qual produto você quer pedir?";
    }

    return [
      "Seu carrinho:",
      "",
      this.formatCartLines(cart),
      "",
      `Subtotal: ${this.formatCurrency(this.cartSubtotal(cart))}`,
      "",
      WhatsappCopy.askAddMoreOrCheckout(),
    ].join("\n");
  }

  private formatFreeDeliveryReply() {
    return [
      "A entrega é grátis por motoboy.",
      "Após a confirmação do pagamento, seu pedido chega em até 30 minutos.",
    ].join("\n");
  }

  private async handleGlobalCancel(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      await this.resetConversationContext(conversation.id);
      return "Atendimento cancelado. Se precisar, é só me chamar por aqui.";
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastIntent: "WAITING_CANCEL_CART" },
    });

    return [
      "Você tem itens no carrinho.",
      "",
      "Você quer limpar o carrinho também?",
      "",
      "1. Sim, limpar carrinho",
      "2. Não, manter carrinho",
    ].join("\n");
  }

  private async handlePendingCancelCart(conversation: Conversation, text: string) {
    if (this.isConfirmChoice(text) || this.isPositiveConfirmation(text)) {
      await this.resetConversationContext(conversation.id);
      return "Carrinho limpo e atendimento cancelado. Se precisar, é só me chamar por aqui.";
    }

    if (this.isCancelKeepCartChoice(text) || this.isNegativeReply(text)) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: null,
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        },
      });

      return [
        "Tudo bem, mantive seu carrinho.",
        "",
        this.formatCartStatus(conversation),
      ].join("\n");
    }

    return "Digite 1 para limpar o carrinho ou 2 para manter.";
  }

  private async handleRemoveItemRequest(conversation: Conversation, text: string) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Qual produto você quer pedir?";
    }

    const itemNumber = this.extractCartItemNumber(text);

    if (!itemNumber) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastIntent: "WAITING_REMOVE_ITEM" },
      });

      return [
        "Qual item você quer remover?",
        "",
        this.formatCartLines(cart),
        "",
        "Digite o número do item.",
      ].join("\n");
    }

    return this.removeCartItemByNumber(conversation, itemNumber);
  }

  private async handlePendingRemoveItem(conversation: Conversation, text: string) {
    const itemNumber = this.extractCartItemNumber(text);

    if (!itemNumber) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastIntent: null },
      });

      return "Não consegui identificar o item. Para remover, envie algo como “remover item 1”.";
    }

    return this.removeCartItemByNumber(conversation, itemNumber);
  }

  private async removeCartItemByNumber(
    conversation: Conversation,
    itemNumber: number,
  ) {
    const cart = this.getCart(conversation.cart);
    const index = itemNumber - 1;

    if (!cart[index]) {
      return [
        "Não encontrei esse item no carrinho.",
        "",
        this.formatCartStatus(conversation),
      ].join("\n");
    }

    const [removed] = cart.splice(index, 1);
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        cart: cart.length > 0 ? this.toJson(cart) : Prisma.JsonNull,
        lastIntent: null,
        pendingAction:
          cart.length > 0
            ? conversation.pendingAction
            : ConversationState.WAITING_MEDICINE_NAME,
      },
    });

    if (cart.length === 0) {
      return `Removi ${formatProductDisplayName(removed.name)} do carrinho. Seu carrinho ficou vazio. Qual produto você quer pedir?`;
    }

    return [
      `Removi ${formatProductDisplayName(removed.name)} do carrinho.`,
      "",
      "Carrinho atualizado:",
      "",
      this.formatCartLines(cart),
      "",
      `Subtotal: ${this.formatCurrency(this.cartSubtotal(cart))}`,
    ].join("\n");
  }

  private async handleSwapCartItemRequest(
    conversation: Conversation,
    text: string,
  ) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Qual produto você quer pedir?";
    }

    const itemNumber = this.extractCartItemNumber(text);

    if (itemNumber) {
      await this.removeCartItemByNumber(conversation, itemNumber);
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: "SWAP_ITEM",
        pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        currentMedicineQuery: null,
        currentRetailCategory: null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
      },
    });

    return itemNumber
      ? "Certo, removi esse item. Qual produto você quer colocar no lugar?"
      : "Claro, qual produto você quer trocar ou colocar no lugar?";
  }

  private async handleBackRequest(conversation: Conversation) {
    if (
      conversation.pendingAction === ConversationState.WAITING_QUANTITY ||
      conversation.pendingAction === ConversationState.WAITING_PRESENTATION
    ) {
      return this.reopenCandidateOptions(conversation);
    }

    if (
      conversation.pendingAction === ConversationState.WAITING_ADDRESS_NUMBER ||
      conversation.pendingAction === ConversationState.WAITING_ADDRESS_COMPLEMENT ||
      conversation.pendingAction === ConversationState.WAITING_CONFIRMATION
    ) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CEP },
      });

      return "Tudo bem. Me envie o CEP novamente ou responda “ver carrinho”.";
    }

    if (conversation.pendingAction === ConversationState.WAITING_CEP) {
      return this.formatCartStatus(conversation);
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        selectedPresentation: Prisma.JsonNull,
      },
    });

    return "Tudo bem. Qual produto você quer consultar?";
  }

  private async reopenCandidateOptions(conversation: Conversation) {
    const options = this.getCandidateOptions(conversation.candidateOptions);

    if (options.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });

      return "Tudo bem. Qual outro produto você quer consultar?";
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_PRESENTATION,
        selectedPresentation: Prisma.JsonNull,
      },
    });

    return [
      "Claro, vou te mostrar outras opções:",
      "",
      this.formatCandidateOptions(options),
      "",
      choicePrompt(),
    ].join("\n");
  }

  private async removeLastCartItemAndReopenOptions(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length > 0) {
      cart.pop();
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { cart: this.toJson(cart) },
    });

    const reopened = await this.reopenCandidateOptions(conversation);
    return [
      "Sem problema, removi o último item do carrinho para você trocar.",
      "",
      reopened,
    ].join("\n");
  }

  private async selectRecommendedCandidate(
    conversation: Conversation,
    mode: CommercialSelectionMode,
  ) {
    const options = this.getCandidateOptions(conversation.candidateOptions);
    const option = this.pickRecommendedOption(options, mode);

    if (!option) {
      return "No momento não encontrei outra opção disponível. Pode me dizer qual produto você quer levar?";
    }

    const pricedOption = await this.ensureSelectedOptionPrice(option);
    await this.saveSelectedOption(conversation.id, pricedOption);

    const reasonByMode: Record<CommercialSelectionMode, string> = {
      recommended: "Minha sugestão para você é:",
      cheapest: "Tenho sim. Esta opção é mais em conta:",
      generic: "Tenho sim. Esta é uma opção genérica:",
      larger: "Claro, tenho esta opção maior:",
      smaller: "Claro, tenho esta opção menor:",
    };

    return [
      reasonByMode[mode],
      "",
      `${formatProductDisplayName(pricedOption.label)}${pricedOption.pricePf ? ` - ${this.formatCurrency(pricedOption.pricePf)}` : ""}`,
      "",
      this.formatSelectedOptionReply(pricedOption),
    ].join("\n");
  }

  private pickRecommendedOption(
    options: CommercialMedicineOption[],
    mode: CommercialSelectionMode,
  ) {
    if (options.length === 0) {
      return null;
    }

    if (mode === "generic") {
      const genericOption = options.find((option) =>
        /\bgen[eé]ric[ao]\b/.test(this.normalize(option.label)),
      );

      if (genericOption) {
        return genericOption;
      }
    }

    if (mode === "larger" || mode === "smaller") {
      const sorted = [...options].sort((a, b) => {
        const diff = this.getOptionSizeScore(a) - this.getOptionSizeScore(b);
        return mode === "larger" ? -diff : diff;
      });

      return sorted[0];
    }

    if (mode === "cheapest") {
      return [...options].sort(
        (a, b) => (a.pricePf ?? Number.MAX_SAFE_INTEGER) - (b.pricePf ?? Number.MAX_SAFE_INTEGER),
      )[0];
    }

    return options[0];
  }

  private sortSummaryByCheapest(summary: RetailProductLookupSummary) {
    return {
      ...summary,
      options: [...summary.options].sort(
        (a, b) => (a.pricePf ?? Number.MAX_SAFE_INTEGER) - (b.pricePf ?? Number.MAX_SAFE_INTEGER),
      ),
    };
  }

  private getOptionSizeScore(option: CommercialMedicineOption) {
    const text = this.normalize(
      [
        option.label,
        option.packageDescription,
        option.description,
        option.strength,
      ]
        .filter(Boolean)
        .join(" "),
    );
    const matches = [...text.matchAll(/\b(\d+(?:[,.]\d+)?)\s*(ml|g|mg|un|und|comprimidos?|capsulas?|cápsulas?|fraldas?)\b/g)];

    if (matches.length === 0) {
      return option.optionId;
    }

    return matches.reduce((score, match) => {
      const value = Number(String(match[1]).replace(",", "."));
      const unit = match[2];
      const multiplier =
        unit === "mg" ? 0.001 : unit === "un" || unit === "und" ? 10 : 1;
      return score + value * multiplier;
    }, 0);
  }

  private formatCandidateOptions(options: CommercialMedicineOption[]) {
    return options
      .slice(0, 3)
      .map((option) => {
        const price = option.pricePf
          ? ` - ${this.formatCurrency(option.pricePf)}`
          : "";
        return `${option.optionId}. ${formatProductDisplayName(option.label)}${price}`;
      })
      .join("\n");
  }

  private formatMedicineInformationReply(
    question: MedicineQuestion,
    summary: { medicineName: string; options: CommercialMedicineOption[] },
  ) {
    const option = summary.options[0];
    const medicineName = formatProductDisplayName(
      option?.medicineName || question.medicineName,
    );
    const presentation = option
      ? formatProductDisplayName(option.label)
      : medicineName;
    const safetyNote =
      "Essa informação é resumida e não substitui a orientação do farmacêutico ou do médico.";

    if (question.intent === "contraindication") {
      return [
        `Sobre ${medicineName}: é importante confirmar contraindicações na bula e com o farmacêutico, principalmente em caso de alergia, gestação, crianças, idosos ou uso de outros medicamentos.`,
        "",
        safetyNote,
        "",
        `Se quiser, também posso consultar opções de ${medicineName} para você.`,
      ].join("\n");
    }

    if (question.intent === "dosage") {
      return [
        `Sobre posologia de ${medicineName}: a forma de uso depende da apresentação, idade e orientação profissional.`,
        option?.packageDescription ? `Apresentação localizada: ${presentation}.` : "",
        "",
        safetyNote,
        "",
        `Se quiser comprar, posso seguir com ${presentation}.`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (question.intent === "composition") {
      return [
        `Sobre composição de ${medicineName}: encontrei ${presentation}.`,
        "Para composição completa, confirme na bula da embalagem ou com o farmacêutico.",
        "",
        safetyNote,
      ].join("\n");
    }

    return [
      `Tenho ${presentation} para você.`,
      "Posso te ajudar com um resumo objetivo, mas não envio a bula completa por aqui.",
      "",
      safetyNote,
      "",
      `Se quiser comprar, responda comprar ${medicineName}.`,
    ].join("\n");
  }

  private formatRetailProductChoiceReply(summary: RetailProductLookupSummary) {
    return WhatsappCopy.showRetailOptions(
      summary.category,
      summary.requestedBrand,
      summary.options,
      this.formatCurrency.bind(this),
    );
  }

  private formatRetailBrandPrompt(category: string) {
    const brands = this.productSearch.getPopularBrands(category).slice(0, 5);
    return WhatsappCopy.askRetailBrand(category, brands);
  }

  private extractRetailProductQuery(message: string) {
    const normalized = this.normalize(message)
      .replace(/[?!.:,;]/g, " ")
      .replace(/\bvoces?\s+(?:tem|teriam|vendem)\b/g, " ")
      .replace(/\b(?:tem|teria|vende|vendem|quero|queria|preciso)\b/g, " ")
      .replace(/\b(?:preco|valor|quanto custa|qual valor)\b/g, " ")
      .replace(/\b(?:por favor|pfv|pra mim|para mim)\b/g, " ")
      .replace(/\b(?:do|da|de|um|uma|o|a)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return normalized.length >= 2 ? normalized : message.trim();
  }

  private isOnlyGenericRetailCategoryQuery(query: string, category: string) {
    const normalizedQuery = this.normalize(query)
      .replace(/[?!.:,;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedCategory = this.normalize(category);
    const genericTerms: Record<string, string[]> = {
      shampoo: ["shampoo", "xampu"],
      condicionador: ["condicionador"],
      sabonete: ["sabonete"],
      desodorante: ["desodorante"],
      fralda: ["fralda", "fraldas"],
      gillette: ["gillette", "gilete"],
      "creme dental": ["creme dental", "pasta de dente"],
      "protetor solar": ["protetor solar"],
    };

    return (genericTerms[normalizedCategory] || [normalizedCategory]).includes(
      normalizedQuery,
    );
  }

  private detectRetailCategoryFromQuery(query: string) {
    const normalized = this.normalize(query);

    if (/\b(fralda|fraldas|pampers|huggies|mamy poko|mamypoko)\b/.test(normalized)) {
      return "fralda";
    }

    if (/\b(protetor solar|fps|sundown|la roche|neutrogena|nivea)\b/.test(normalized)) {
      return "protetor solar";
    }

    if (/\b(gillette|gilete|prestobarba|mach3|aparelho de barbear|lamina de barbear)\b/.test(normalized)) {
      return "gillette";
    }

    return null;
  }

  private async changeSelectedOption(conversation: Conversation, text: string) {
    const selectedOption = await this.selectCandidateOption(conversation, text);

    if (!selectedOption) {
      return null;
    }

    await this.saveSelectedOption(conversation.id, selectedOption);

    return this.formatSelectedOptionReply(selectedOption);
  }

  private async selectCandidateOption(conversation: Conversation, text: string) {
    const currentMedicineQuery =
      conversation.currentMedicineQuery || conversation.lastMedicine;
    const options = this.getCandidateOptions(conversation.candidateOptions).filter(
      (option) =>
        option.type === "retail_product" ||
        this.bulaApiService.optionBelongsToMedicine(
          currentMedicineQuery,
          option,
        ),
    );
    const explicitOption = this.findOptionByNumber(text, options);
    const option =
      explicitOption ||
      this.findRetailOptionByReply(text, options) ||
      this.bulaApiService.findOptionByReply(text, options);

    if (!option) {
      return null;
    }

    const pricedOption = await this.ensureSelectedOptionPrice(option);
    this.logger.log(`Opção escolhida: ${pricedOption.label}`);
    if (pricedOption.type === "retail_product") {
      this.logger.log(`RETAIL PRODUCT SELECTED: ${pricedOption.label}`);
    }
    return pricedOption;
  }

  private async ensureSelectedOptionPrice(option: CommercialMedicineOption) {
    if (
      option.type === "retail_product" ||
      option.pricePf !== undefined ||
      option.selectionReason?.includes("fonte pharmadb") ||
      option.selectionReason?.includes("fonte popular_manual")
    ) {
      return option;
    }

    return this.bulaApiService.priceSelectedOption(option);
  }

  private formatSelectedOptionReply(option: CommercialMedicineOption) {
    if (option.type !== "retail_product") {
      return WhatsappCopy.confirmMedicineSelection(
        option,
        this.formatCurrency.bind(this),
      );
    }

    return WhatsappCopy.confirmRetailSelection(
      option,
      this.formatCurrency.bind(this),
    );
  }

  private findRetailOptionByReply(
    text: string,
    options: CommercialMedicineOption[],
  ) {
    const normalized = this.normalize(text).trim();

    return (
      options.find((option) => {
        if (option.type !== "retail_product") {
          return false;
        }

        const searchText = this.normalize(
          [option.label, option.productName, option.brand, option.description]
            .filter(Boolean)
            .join(" "),
        );

        return normalized.length >= 2 && searchText.includes(normalized);
      }) || null
    );
  }

  private formatMissingPrice(option: CommercialMedicineOption) {
    return option.type === "retail_product"
      ? `Valor: ${this.formatCurrency(option.pricePf)}.`
      : "No momento não encontrei preço para essa apresentação.";
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
        : this.formatMissingPrice(option);
    } else if (
      /\b(quantos|vem quantos|qual embalagem|embalagem)\b/.test(normalized)
    ) {
      answer = option.packageDescription
        ? `A embalagem selecionada vem com ${option.packageDescription.replace(/^caixa com\s+/i, "")}.`
        : "No momento não encontrei a embalagem detalhada dessa apresentação.";
    } else if (
      /\b(comprimido|comprimidos|capsula|capsulas|gotas)\b/.test(normalized)
    ) {
      answer = `A apresentação selecionada é ${this.formatPresentationText(option.formGroup)}.`;
    } else {
      answer = option.packageDescription
        ? `A embalagem selecionada vem com ${option.packageDescription.replace(/^caixa com\s+/i, "")}.`
        : "No momento não encontrei a embalagem detalhada dessa apresentação.";
    }

    return [answer, "", this.repeatStatePrompt(state)].join("\n");
  }

  private answerCurrentItemPrice(
    option: CommercialMedicineOption,
    state: ConversationState,
  ) {
    const answer = option.pricePf
      ? `O valor é ${this.formatCurrency(option.pricePf)}.`
      : this.formatMissingPrice(option);

    return [answer, "", this.repeatStatePrompt(state)].join("\n");
  }

  private formatOrderConfirmation(
    conversation: Conversation,
    address: PendingAddress,
  ) {
    const cart = this.getCart(conversation.cart);
    const subtotal = this.cartSubtotal(cart);
    const deliveryFee = 0;
    const addressText = this.formatAddressForOrder(address);

    return WhatsappCopy.orderConfirmation(
      this.formatCartLines(cart),
      subtotal,
      deliveryFee,
      addressText,
      this.formatCurrency.bind(this),
    );
  }

  private parseAddressComplement(text: string): Pick<
    PendingAddress,
    "addressComplement" | "addressReference"
  > {
    const value = text.trim();

    if (this.isNoComplementReply(value)) {
      return {
        addressComplement: null,
        addressReference: null,
      };
    }

    if (this.looksLikeAddressReference(value)) {
      return {
        addressComplement: null,
        addressReference: value,
      };
    }

    return {
      addressComplement: value,
      addressReference: null,
    };
  }

  private formatAddressForOrder(address: PendingAddress) {
    const lines = [
      `${sanitizeCustomerText(address.logradouro)}, número ${sanitizeCustomerText(address.number)}`,
      address.addressComplement
        ? `Complemento: ${sanitizeCustomerText(address.addressComplement)}`
        : null,
      address.addressReference
        ? `Referência: ${sanitizeCustomerText(address.addressReference)}`
        : null,
      `${sanitizeCustomerText(address.bairro)}, ${sanitizeCustomerText(address.localidade)}/${sanitizeCustomerText(address.uf)}`,
    ];

    return lines.filter(Boolean).join("\n");
  }

  private buildCartItem(
    option: CommercialMedicineOption,
    quantity: number,
  ): CartItem {
    const total =
      option.pricePf !== undefined ? Number((option.pricePf * quantity).toFixed(2)) : undefined;

    return {
      type: option.type || "medicine",
      medicineName: sanitizeCustomerText(option.medicineName),
      name: formatProductDisplayName(option.label),
      brand: sanitizeCustomerText(option.brand),
      form: sanitizeCustomerText(option.formGroup),
      presentation: sanitizeCustomerText(option.packageDescription),
      description: sanitizeCustomerText(option.description),
      dosage: sanitizeCustomerText(option.strength),
      packageInfo: sanitizeCustomerText(option.packageDescription),
      unitPrice: option.pricePf,
      quantity,
      total,
      imageUrl: option.imageUrl,
      source: option.source || option.selectionReason,
    };
  }

  private formatCartLines(cart: CartItem[]) {
    if (cart.length === 0) {
      return "Nenhum item no carrinho.";
    }

    return cart
      .map((item, index) => {
        const total =
          item.total !== undefined
            ? this.formatCurrency(item.total)
            : this.formatCurrency(0);
        return `${index + 1}. ${formatProductDisplayName(item.name)} - ${item.quantity} un - ${total}`;
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
      return WhatsappCopy.askQuantity();
    }

    if (state === ConversationState.WAITING_CEP) {
      return WhatsappCopy.askCep();
    }

    if (state === ConversationState.WAITING_ADDRESS_COMPLEMENT) {
      return WhatsappCopy.askAddressComplement();
    }

    if (state === ConversationState.WAITING_CONFIRMATION) {
      return "Confirma o pedido?\n\n1. Confirmar\n2. Adicionar mais produtos\n3. Cancelar";
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
        currentRetailCategory: null,
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

  private isViewCartRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(ver carrinho|carrinho|meu carrinho|mostrar carrinho|resumo do pedido)$/.test(
      normalized,
    );
  }

  private isRemoveItemRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(remover|remove|tirar|excluir|apagar)\b.*\b(item|produto|carrinho)?\b/.test(
      normalized,
    );
  }

  private isSwapCartItemRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(trocar item|trocar produto|substituir item|substituir produto)\b/.test(
      normalized,
    );
  }

  private isBackRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(voltar|volta|anterior|menu anterior)$/.test(normalized);
  }

  private isFinalizeRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(finalizar|fechar pedido|concluir pedido|calcular entrega e finalizar|quero finalizar)$/.test(
      normalized,
    );
  }

  private isPaymentCommand(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(pix|manda o pix|mandar pix|enviar pix|pagar|quero pagar|gerar pix novamente|gerar pix|tentar pix novamente|status do pagamento|pagamento|ja paguei|já paguei|paguei|fiz o pix)$/.test(
      normalized,
    );
  }

  private isAlreadyPaidCommand(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(ja paguei|já paguei|paguei|pagamento feito|fiz o pix)$/.test(
      normalized,
    );
  }

  private isPixRetryCommand(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(1|pix|gerar pix|gerar pix novamente|tentar novamente|tentar pix novamente|manda o pix|mandar pix|enviar pix|pagar|quero pagar)$/.test(
      normalized,
    );
  }

  private isPixCancelChoice(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(2|cancelar|cancela|cancelar pedido|desistir)$/.test(normalized);
  }

  private isRecommendationRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(recomenda|indicad[ao]|melhor opcao|melhor opção|mais vendid[ao])\b/.test(
      normalized,
    );
  }

  private isCheapestRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(mais barato|menor preco|menor valor|preco menor|valor menor|mais em conta|mais economico)\b/.test(
      normalized,
    );
  }

  private isGenericRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(generico|gen[eé]rico|tem generico|tem gen[eé]rico)\b/.test(
      normalized,
    );
  }

  private isLargerRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(tem maior|maior embalagem|embalagem maior|maior quantidade|frasco maior|pacote maior)\b/.test(
      normalized,
    );
  }

  private isSmallerRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(tem menor|menor embalagem|embalagem menor|menor quantidade|frasco menor|pacote menor)\b/.test(
      normalized,
    );
  }

  private getCommercialSelectionMode(text: string): CommercialSelectionMode {
    if (this.isCheapestRequest(text)) return "cheapest";
    if (this.isGenericRequest(text)) return "generic";
    if (this.isLargerRequest(text)) return "larger";
    if (this.isSmallerRequest(text)) return "smaller";
    return "recommended";
  }

  private isRejectionRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(nao gostei|não gostei|nao quero esse|não quero esse|tem outro|tem outra|outra opcao|outra opção)$/.test(
      normalized,
    );
  }

  private isOpenChangeRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(quero trocar|trocar|troca|mudar|quero mudar|ver opcoes|ver opções)$/.test(
      normalized,
    );
  }

  private isMoreOptionsRequest(text: string) {
    const normalized = this.normalize(text);
    return /\b(tem outros|tem outro modelo|tem outros modelos|outro modelo|outros modelos|mais opcoes|ver mais|quero ver outros|mostra mais|outras opcoes|outra marca|outras marcas|tem similar|similares)\b/.test(
      normalized,
    );
  }

  private isDeliveryPriceQuestion(text: string) {
    const normalized = this.normalize(text);
    return /\b(quanto fica a entrega|valor da entrega|preco da entrega|taxa de entrega|frete)\b/.test(
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

  private isAddMoreChoice(text: string) {
    const normalized = this.normalize(text).trim();
    return (
      normalized === "1" ||
      /^(adicionar|adicionar mais|mais produtos)$/.test(normalized)
    );
  }

  private isAddMoreConfirmationChoice(text: string) {
    const normalized = this.normalize(text).trim();
    return (
      normalized === "2" ||
      /^(adicionar|adicionar mais|mais produtos|adicionar mais produtos)$/.test(
        normalized,
      )
    );
  }

  private isDeliveryRequest(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(2|calcular entrega|entrega|finalizar|calcular entrega e finalizar pedido|nao|não)$/.test(
      normalized,
    );
  }

  private isConfirmChoice(text: string) {
    return this.normalize(text).trim() === "1";
  }

  private isCancelChoice(text: string) {
    return this.normalize(text).trim() === "3";
  }

  private isCancelKeepCartChoice(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(2|manter|manter carrinho|nao limpar|não limpar)$/.test(
      normalized,
    );
  }

  private isPositiveConfirmation(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(sim|confirmo|pode confirmar|confirmar|ok|fechado)\b/.test(
      normalized,
    );
  }

  private isNegativeReply(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(nao|não|n)$/.test(normalized);
  }

  private isNoComplementReply(text: string) {
    const normalized = this.normalize(text).trim();
    return /^(nao|não|nao tenho|não tenho|sem complemento|nenhum|n)$/.test(
      normalized,
    );
  }

  private looksLikeAddressReference(text: string) {
    const normalized = this.normalize(text);
    return /\b(proximo|próximo|perto|referencia|referência|mercado|padaria|esquina|casa azul|portao|portão)\b/.test(
      normalized,
    );
  }

  private isInformationalMedicineIntent(intent: string) {
    return ["leaflet", "contraindication", "composition", "dosage"].includes(
      intent,
    );
  }

  private isAddressNumber(value: string) {
    const normalized = this.normalize(value).trim();
    return /\d+[a-zA-Z]?/.test(value) || /^(s\/n|sn|sem numero|sem número)$/.test(normalized);
  }

  private extractDiaperSize(text: string) {
    const normalized = this.normalize(text).toUpperCase();
    const match = normalized.match(/\b(RN|XXG|XG|GG|G|M|P)\b/);
    return match?.[1] || null;
  }

  private extractSunscreenFps(text: string) {
    const normalized = this.normalize(text);
    const match = normalized.match(/\b(?:fps\s*)?(30|50|60|70|80|90|99|100)\b/);
    return match?.[1] || null;
  }

  private extractCartItemNumber(text: string) {
    const normalized = this.normalize(text);
    const match = normalized.match(
      /\b(?:item|produto)?\s*(\d+)\b|\b(?:remover|tirar|excluir|trocar)\s+(\d+)\b/,
    );
    const value = match ? Number(match[1] || match[2]) : null;
    return value && value > 0 ? value : null;
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
    if (value === undefined || !Number.isFinite(value)) {
      return "";
    }

    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  }

  private capitalize(value: string) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private normalizePixCopyPaste(value: string) {
    return value.replace(/\s+/g, "");
  }

  private formatPresentationText(value: string) {
    const normalized = this.normalize(value);
    const labels: Record<string, string> = {
      capsula: "cápsula",
      capsulas: "cápsulas",
      "solucao oral": "solução oral",
      "suspensao oral": "suspensão oral",
      "solucao nasal": "solução nasal",
      dragea: "drágea",
    };

    return labels[normalized] || value;
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
