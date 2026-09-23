import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { validWebQuote, WEB_MEDICINE_PRICE_POLICY, WebMedicineQuote } from "../config/web-medicine.config";
import { OpenAiWebMedicineService } from "../integrations/openai-web-medicine.service";
import { Conversation, ConversationState, Prisma } from "@prisma/client";
import { AiService } from "../ai/ai.service";
import { SymptomMedicineRule } from "../config/symptom-medicine.config";
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
import { ConversationInputService } from "./conversation-input.service";
import { getConversationOpeningIntent } from "../utils/conversation-opening.util";
import { addressFieldPrompt, missingAddressField, parseAddressField } from "./delivery-address";
import { CATALOG_PRICE_POLICY } from "../config/preco-popular.config";
import { PrecoPopularService } from "../integrations/preco-popular.service";
import { PackageImageReading, packageImageSchema } from "../ai/package-image.types";
import { extractMedicineStrengths, medicinePresentationStrengthMatches } from "../utils/medicine-strength.util";
import { catalogQuarantineReason } from "../config/catalog-quality.config";
import { medicineSpellingSuggestion } from "../config/medicine-spelling.config";
import { explicitRetailCategories, isGenericRetailCategoryQuery, normalizeRetailSearchQuery } from "../utils/retail-search-query.util";
import { foldCustomerQuery, hasMultipleProductRequests, namedQueryBeforeSymptom } from "../utils/customer-query.util";

interface CartItem {
  webQuote?: WebMedicineQuote;
  pricePolicy?: string;
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
  sourceId?: string;
  ean?: string;
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
    private readonly inputService: ConversationInputService = new ConversationInputService(),
    private readonly catalog?: PrecoPopularService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly webMedicine?: OpenAiWebMedicineService,
  ) {}

  async resolveReply(conversation: Conversation, text: string) {
    this.logger.log(`Mensagem recebida: ${text}`);
    this.logger.log(`Estado atual: ${conversation.pendingAction}`);

    if (this.isResetCommand(text)) {
      await this.resetConversationContext(conversation.id);
      return WhatsappCopy.resetConversation();
    }

    if (conversation.pendingAction === ConversationState.WAITING_PIX) {
      return this.handleWaitingPix(conversation, text);
    }

    // Resume chats left by the retired handoff flow without losing cart/address.
    if (["CATALOG_HELP_OPTIONS", "CATALOG_REVIEW_REQUESTED", "CATALOG_REVIEW_HANDLED"].includes(conversation.lastIntent || "")) {
      const patch = { lastIntent: "CATALOG_UNAVAILABLE", pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        selectedPresentation: Prisma.JsonNull, candidateOptions: Prisma.JsonNull };
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: patch });
      conversation = { ...conversation, ...patch, selectedPresentation: null, candidateOptions: null };
      if (/^(?:1|sim|atendimento|atendente|solicitar atendimento)[.!?]*$/i.test(text.trim())) {
        const query = conversation.currentMedicineQuery || conversation.lastMedicine;
        return query ? this.handleMedicineQuestion(conversation.id, { intent: "purchase", medicineName: query, searchQuery: query })
          : "Qual produto você procura?";
      }
      if (/^[2-9]$/.test(text.trim())) return "Qual outro produto você procura?";
    }

    const openingIntent = getConversationOpeningIntent(text);
    if (openingIntent === "greeting") {
      return this.handleGreeting(conversation);
    }

    if (openingIntent === "start_order") {
      return this.handleOrderOpening(conversation);
    }

    const plain = foldCustomerQuery(text).replace(/[?!.]/g, "").trim();
    if (/\b(?:entrega|entregam|delivery|pedido minimo|valor minimo|minimo do pedido)\b/.test(plain) &&
        /^(?:voces|vcs|qual|a partir|entrega|entregam|fazem|tem delivery|pedido minimo)/.test(plain)) {
      return "Ainda não consigo confirmar entrega ou pedido mínimo para essa região. Qual produto você procura?";
    }
    if (/^(?:vc|vcs|voce|voces)?\s*(?:tem|tem esse|tem essa)?\s*(?:esse|essa|este|esta)?\s*(?:remedio|medicamento|produto)$/.test(plain) ||
        /^(?:serio|drogaria|oie|oii+|qual opcao|qual opcao 👆|nao tem dessa|nao tem desse)$/.test(plain)) {
      return "Pode me dizer o nome do produto e a apresentação que procura? Assim consulto a opção certa para você.";
    }
    if (/^(?:tem\s+|quero\s+)?(?:colirio|injetavel|pomada)$/.test(plain)) {
      return "Qual é o nome do medicamento que você procura? Pode escrever como aparece na embalagem para eu consultar a apresentação certa.";
    }
    if (/\b(?:modificar|alterar|editar)\s+(?:o |meu )?pedido\b/.test(plain)) {
      return `${this.formatCartStatus(conversation)}\n\nVocê pode pedir para remover um item, adicionar outro produto ou cancelar o pedido.`;
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

      return "Claro. Me diga qual outro produto você quer incluir no pedido.";
    }

    if (conversation.lastIntent === "CATALOG_UNAVAILABLE" &&
        conversation.pendingAction === ConversationState.WAITING_MEDICINE_NAME) {
      const answer = this.normalize(text).replace(/[,;.!?]+/g, " ").replace(/\s+/g, " ").trim();
      if (/^(tentar novamente|tente novamente|buscar novamente|tenta de novo)$/.test(answer)) {
        const query = conversation.currentMedicineQuery || conversation.lastMedicine;
        return query ? this.handleMedicineQuestion(conversation.id, { intent: "purchase", medicineName: query, searchQuery: query })
          : "Qual produto você procura?";
      }
      if (/^(sim|quero|quero sim|pode ser|outro produto|buscar outro produto)$/.test(answer)) {
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: {
          lastIntent: "ADD_ITEM", currentMedicineQuery: null, currentRetailCategory: null,
          lastMedicine: null, candidateOptions: Prisma.JsonNull,
        } });
        return "Claro! Qual produto você procura?";
      }
      if (/^(nao|nao obrigado|nao obrigada|agora nao|por enquanto nao)$/.test(answer)) {
        return "Tudo bem! Quando precisar, é só me chamar por aqui.";
      }
    }

    if (conversation.lastIntent === "WAITING_PACKAGE_IMAGE_CONFIRMATION" &&
        conversation.pendingAction === ConversationState.WAITING_MEDICINE_NAME) {
      return this.handlePackageImageConfirmation(conversation, text);
    }
    if (conversation.lastIntent === "WAITING_MEDICINE_SPELLING_CONFIRMATION" &&
        conversation.pendingAction === ConversationState.WAITING_MEDICINE_NAME) {
      return this.handleMedicineSpellingConfirmation(conversation, text);
    }

    // Address answers must not become medicine/dosage queries (e.g. Rua 1 de Maio).
    if (conversation.pendingAction === ConversationState.WAITING_ADDRESS_NUMBER) {
      return this.handleWaitingAddressNumber(conversation, text);
    }
    if (conversation.pendingAction === ConversationState.WAITING_ADDRESS_COMPLEMENT) {
      return this.handleWaitingAddressComplement(conversation, text);
    }

    // A short answer to a retail question is not a new medicine search.
    if (this.isRetailClarificationReply(conversation, text)) {
      return this.handleWaitingRetailBrand(conversation, text);
    }

    if (conversation.pendingAction === ConversationState.WAITING_QUANTITY && this.inputService.isQuantityReply(text)) {
      return this.handleWaitingQuantity(conversation, text);
    }
    if (/^(?:\d+\s+)?(?:desse|dessa|desses|dessas|esse|essa|sim|ok)$/.test(plain) &&
        [ConversationState.IDLE, ConversationState.WAITING_MEDICINE_NAME].includes(conversation.pendingAction as "IDLE" | "WAITING_MEDICINE_NAME")) {
      return "Qual é o nome do produto a que você se refere? Pode escrever o nome e a apresentação para eu continuar.";
    }
    if (hasMultipleProductRequests(text)) {
      return "Recebi mais de um item. Vamos começar por qual produto? Envie o nome e a apresentação de um por vez para não misturarmos as dosagens. Seu carrinho será mantido.";
    }
    const formReply = plain.match(/^(?:(?:sim|so|que|o|e|tem|quero|preciso|prefiro|mas|seria)\s+)*(?:em|de)\s+(gotas|pomada|creme|gel|comprimidos?|capsulas?|xarope)(?:\s+que\s+preciso)?$/);
    const baseName = conversation.currentMedicineQuery || conversation.lastMedicine;
    if (formReply && baseName) {
      return this.handleMedicineQuestion(conversation.id, { intent: "purchase", medicineName: baseName,
        searchQuery: `${this.bulaApiService.normalizeMedicineName(baseName) || baseName} ${formReply[1]}` });
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
    const dosageContextOption =
      selectedOption ||
      this.getCandidateOptions(conversation.candidateOptions).find(
        (option) => option.type !== "retail_product",
      );
    const dosageChangeReply = retailProductQuery ? null : await this.handleDosageChangeFromContext(
      conversation,
      text,
      dosageContextOption,
    );

    if (dosageChangeReply) {
      return dosageChangeReply;
    }

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
      (this.hasExplicitMedicineSearchIntent(text) || conversation.pendingAction === ConversationState.WAITING_QUANTITY) &&
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
      case ConversationState.WAITING_CONFIRMATION:
        return this.handleWaitingConfirmation(conversation, text);
      case ConversationState.IDLE:
      default:
        return this.handleIdle(conversation, text, medicineQuestion);
    }
  }

  async requestPackageImageConfirmation(conversation: Conversation, reading: PackageImageReading) {
    const parsed = packageImageSchema.safeParse(reading);
    if (!parsed.success || !parsed.data.medicineName || parsed.data.confidence < 0.85) {
      return WhatsappCopy.packageImageFallback("unreadable");
    }
    const query = [parsed.data.medicineName, parsed.data.dosage, parsed.data.form].filter(Boolean).join(" ");
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: "WAITING_PACKAGE_IMAGE_CONFIRMATION",
        pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        currentMedicineQuery: null,
        currentRetailCategory: null,
        lastMedicine: null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: this.toJson({ packageImageQuery: query }),
      },
    });
    return WhatsappCopy.confirmPackageImage(query);
  }

  private async handlePackageImageConfirmation(conversation: Conversation, text: string): Promise<string | string[]> {
    const stored = conversation.candidateOptions;
    const query = stored && typeof stored === "object" && !Array.isArray(stored) &&
      typeof stored.packageImageQuery === "string" ? stored.packageImageQuery : null;
    const yes = /^(1|sim|isso|isso mesmo|correto|confirmo|ok)[.!?]*$/i.test(this.normalize(text).trim());
    const no = /^(2|nao|corrigir|voltar)[.!?]*$/i.test(this.normalize(text).trim());
    if (query && !yes && !no && /^\d+$/.test(text.trim())) {
      return WhatsappCopy.confirmPackageImage(query);
    }
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastIntent: null, candidateOptions: Prisma.JsonNull },
    });
    if (!query || no) return "Claro. Escreva o nome e a dosagem como aparecem na embalagem.";
    const correctedForm = this.normalize(text).match(/\bem\s+(gotas|pomada|creme|gel|comprimidos?|capsulas?|xarope)\b/);
    // OCR data is only a search term, never a cart choice or a payment instruction.
    return this.resolveReply(
      { ...conversation, lastIntent: null, candidateOptions: null },
      yes ? `Quero comprar ${query}` : correctedForm ? `${this.bulaApiService.normalizeMedicineName(query) || query} ${correctedForm[1]}` : text,
    );
  }

  private async handleMedicineSpellingConfirmation(conversation: Conversation, text: string): Promise<string | string[]> {
    const stored = conversation.candidateOptions;
    const query = stored && typeof stored === "object" && !Array.isArray(stored) &&
      typeof stored.spellingQuery === "string" ? stored.spellingQuery : null;
    const yes = /^(1|sim|isso|isso mesmo|correto|confirmo|ok)[.!?]*$/.test(this.normalize(text).trim());
    const no = /^(2|nao)[.!?]*$/.test(this.normalize(text).trim());
    if (query && !yes && !no && /^\d+$/.test(text.trim())) {
      return "Confirme o nome: 1 para sim ou 2 para não. Se preferir, escreva o nome correto da embalagem.";
    }
    await this.prisma.conversation.update({ where: { id: conversation.id },
      data: { lastIntent: null, candidateOptions: Prisma.JsonNull } });
    if (!query || no) return "Tudo bem. Escreva o nome como aparece na embalagem. Não vou trocar por outro medicamento.";
    return this.resolveReply({ ...conversation, lastIntent: null, candidateOptions: null },
      yes ? `Quero comprar ${query}` : text);
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

      return "Qual produto você quer consultar? Pode me mandar o nome ou a marca.";
    }

    const symptomSuggestion = this.medicineSearch.findSymptomSuggestion(text);

    const namedQuery = symptomSuggestion && namedQueryBeforeSymptom(text, symptomSuggestion);
    if (namedQuery) return this.handleMedicineQuestion(conversation.id, { intent: "purchase", medicineName: namedQuery, searchQuery: namedQuery });
    if (symptomSuggestion) {
      return this.handleSymptomMedicineQuestion(conversation, symptomSuggestion);
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
    const symptomSuggestion = this.medicineSearch.findSymptomSuggestion(text);

    const namedQuery = symptomSuggestion && namedQueryBeforeSymptom(text, symptomSuggestion);
    if (namedQuery) return this.handleMedicineQuestion(conversation.id, { intent: "purchase", medicineName: namedQuery, searchQuery: namedQuery });
    if (symptomSuggestion) {
      return this.handleSymptomMedicineQuestion(conversation, symptomSuggestion);
    }

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

    return "Me diga o nome do medicamento que eu procuro as melhores opções para você.";
  }

  private isRetailClarificationReply(conversation: Conversation, text: string) {
    if (conversation.pendingAction !== ConversationState.WAITING_RETAIL_BRAND || !conversation.currentRetailCategory) return false;
    const reply = normalizeRetailSearchQuery(text);
    if (conversation.lastIntent === "WAITING_DIAPER_AUDIENCE") return /^(?:infantil|bebe|crianca|adulto|geriatrica)$/.test(reply);
    const brands = (this.productSearch.getPopularBrands(conversation.currentRetailCategory) || []).map(normalizeRetailSearchQuery);
    const withoutBrand = brands.reduce((value, brand) => {
      if (value.startsWith(`${brand} `)) return value.slice(brand.length).trim();
      if (value.endsWith(` ${brand}`)) return value.slice(0, -brand.length).trim();
      return value;
    }, reply);
    if (conversation.lastIntent === "WAITING_DIAPER_SIZE") return /^(?:tamanho\s*)?(?:rn|xxg|xg|gg|g|m|p)$/.test(withoutBrand);
    if (conversation.lastIntent === "WAITING_SUNSCREEN_FPS") return /^(?:fps\s*)?\d{1,3}$/.test(withoutBrand);
    return brands.includes(reply) || this.productSearch.isAnyBrandReply(reply);
  }

  private async handleWaitingRetailBrand(conversation: Conversation, text: string) {
    const category = conversation.currentRetailCategory;

    if (!category) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.IDLE },
      });

      return "Me diga qual produto você quer consultar.";
    }
    if (conversation.lastIntent === "WAITING_DIAPER_AUDIENCE") {
      const audience = foldCustomerQuery(text);
      if (!/^(?:infantil|bebe|crianca|adulto|geriatrica)$/.test(audience)) return "A fralda é infantil ou para adulto?";
      return this.handleRetailProductQuestion(conversation.id,
        `${conversation.currentMedicineQuery || "fralda"} ${/adulto|geriatrica/.test(audience) ? "adulto" : "infantil"}`,
        { category: "fralda", selectedBrand: "público confirmado" });
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

      return "Tudo bem. Me diga qual outro produto você quer consultar.";
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
        "Encontrei estas opções disponíveis:",
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
      return "Claro. Me diga qual produto você quer ver que eu busco outras opções.";
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
      `Claro. Vou buscar outras opções de ${formatProductDisplayName(category)}${brand ? ` ${formatProductDisplayName(brand)}` : ""}.`,
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
      return "Não consegui identificar a opção. Pode responder com o número da opção ou me dizer a apresentação que prefere.";
    }

    await this.saveSelectedOption(conversation.id, selectedOption);
    return this.formatSelectedOptionReply(selectedOption);
  }

  private async handleWaitingQuantity(conversation: Conversation, text: string) {
    if (this.isRejectionRequest(text) || this.isOpenChangeRequest(text)) {
      return this.reopenCandidateOptions(conversation);
    }

    const quantity = this.inputService.parseQuantity(text);

    if (!quantity) {
      return WhatsappCopy.askQuantity();
    }

    const selectedOption = this.getSelectedOption(conversation);

    if (!selectedOption) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });
      return "Não encontrei a opção selecionada. Me diga qual produto você quer adicionar.";
    }

    const requestedPack = this.inputService.packageCountInQuantity(text);
    if (requestedPack !== undefined && selectedOption.packageInfo?.unitCount !== requestedPack) {
      return "A quantidade por embalagem que você informou não está confirmada para a opção selecionada. Pode conferir a apresentação antes de adicionarmos ao carrinho?";
    }

    const cart = this.getCart(conversation.cart);
    const currentOption = await this.ensureSelectedOptionPrice(selectedOption);
    if (!currentOption.pricePf) {
      return "Não consegui atualizar o valor dessa opção. Me envie o nome do produto para consultar novamente.";
    }
    if (currentOption.pricePf !== selectedOption.pricePf) {
      await this.saveSelectedOption(conversation.id, currentOption);
      return ["O valor dessa opção foi atualizado.", "", this.formatSelectedOptionReply(currentOption)].join("\n");
    }
    const item = this.buildCartItem(currentOption, quantity);
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

      return "Claro. Me diga qual produto você quer adicionar.";
    }

    if (this.isDeliveryPriceQuestion(text)) {
      return this.formatFreeDeliveryReply();
    }

    if (this.isDeliveryRequest(text)) {
      return WhatsappCopy.askCep();
    }

    const cep = this.inputService.parseCep(text);

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

      return "Me envie o CEP da entrega para eu continuar. Pode mandar apenas os 8 dígitos.";
    }

    const foundAddress = await this.viaCepService.findAddressByCep(cep);
    const address: PendingAddress = {
      logradouro: "", bairro: "", localidade: "", uf: "", complemento: "",
      ...foundAddress,
      // Retain the CEP supplied by the customer, never a different one from the API.
      cep,
    };

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_ADDRESS_NUMBER,
        lastIntent: this.extractConfirmedOrderId(conversation.lastIntent) ? conversation.lastIntent : "DELIVERY_ADDRESS",
        pendingAddress: this.toJson(address),
      },
    });

    const field = missingAddressField(address);
    if (field && field !== "number") {
      const explanation = foundAddress
        ? "Esse CEP não trouxe o endereço completo. Vamos completar os dados."
        : "Não consegui consultar esse CEP agora. Confira se os números estão certos. Podemos continuar preenchendo o endereço por aqui.";
      return [explanation, "", addressFieldPrompt(field)].join("\n");
    }
    return WhatsappCopy.askAddressNumber(
      [address.logradouro, address.bairro, `${address.localidade}-${address.uf}`].filter(Boolean).join(", "),
    );
  }

  private async handleWaitingAddressNumber(
    conversation: Conversation,
    text: string,
  ) {
    const pendingAddress = this.getPendingAddress(conversation.pendingAddress);

    if (!pendingAddress) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CEP },
      });
      return "Não encontrei o endereço anterior. Pode me enviar o CEP novamente?";
    }

    const field = missingAddressField(pendingAddress) || "number";
    if (field === "cep") return this.requestMissingAddress(conversation, pendingAddress);
    const value = parseAddressField(field, text);
    if (!value) return addressFieldPrompt(field);
    const address = { ...pendingAddress, [field]: value };
    const nextField = missingAddressField(address);
    if (nextField) return this.requestMissingAddress(conversation, address);
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

    if (!pendingAddress || missingAddressField(pendingAddress)) {
      return this.requestMissingAddress(conversation, pendingAddress);
    }

    const address = {
      ...pendingAddress,
      ...this.parseAddressComplement(text),
    };
    const pricing = await this.refreshCheckoutPrices(conversation);
    if (pricing.error) return pricing.error;

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        pendingAction: ConversationState.WAITING_CONFIRMATION,
        pendingAddress: this.toJson(address),
      },
    });

    return this.formatOrderConfirmation({ ...conversation, cart: this.toJson(pricing.cart) }, address);
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

      return "Claro. Me diga qual outro produto você quer incluir no pedido.";
    }

    if (this.isGlobalCancelRequest(text) || this.isCancelChoice(text)) {
      await this.resetConversationContext(conversation.id);
      return "Pedido cancelado. Quando precisar, é só me chamar por aqui.";
    }

    return "Está tudo certo para confirmar?\n\n1. Confirmar pedido\n2. Adicionar mais produtos\n3. Cancelar";
  }

  private async confirmOrderAndCreatePayment(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });

      return "Seu carrinho ainda está vazio. Me diga o que você precisa que eu procuro para você.";
    }

    const address = this.getPendingAddress(conversation.pendingAddress);
    if (missingAddressField(address)) {
      return this.requestMissingAddress(conversation, address);
    }
    const existingOrderId = this.extractConfirmedOrderId(conversation.lastIntent);
    // Issued Pix/orders keep their agreed amount. Only unconfirmed carts migrate.
    const pricing = existingOrderId
      ? { cart, changed: false, error: null }
      : await this.refreshCheckoutPrices(conversation);
    if (pricing.error) return pricing.error;
    if (pricing.changed) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CONFIRMATION },
      });
      return ["Atualizei os valores do carrinho. Confira o total antes de confirmar.", "",
        this.formatOrderConfirmation({ ...conversation, cart: this.toJson(pricing.cart) }, address!)].join("\n");
    }
    const payment = await this.paymentsService.confirmCheckout({
      conversationId: conversation.id,
      customerId: conversation.customerId,
      cart: pricing.cart,
      address,
      existingOrderId,
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

  private async requestMissingAddress(conversation: Conversation, address: PendingAddress | null) {
    const field = missingAddressField(address) || "number";
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: this.extractConfirmedOrderId(conversation.lastIntent) ? conversation.lastIntent : "DELIVERY_ADDRESS",
        pendingAction: field === "cep"
          ? ConversationState.WAITING_CEP
          : ConversationState.WAITING_ADDRESS_NUMBER,
        pendingAddress: address ? this.toJson(address) : Prisma.JsonNull,
      },
    });
    return addressFieldPrompt(field);
  }

  private async handleWaitingPix(conversation: Conversation, text: string) {
    if (this.isPixRetryCommand(text)) {
      return this.confirmOrderAndCreatePayment(conversation);
    }

    if (this.isPixCancelChoice(text)) {
      await this.resetConversationContext(conversation.id);
      return "Pedido cancelado. Quando precisar, é só me chamar por aqui.";
    }

    if (this.isAlreadyPaidCommand(text)) {
      return this.formatWaitingPaymentConfirmationReply();
    }

    return this.formatPaymentProofRequestReply();
  }

  private async handlePaymentCommand(conversation: Conversation, text: string) {
    const order = await this.paymentsService.findLatestPaymentForCustomer(
      conversation.customerId,
    );
    const payment = order?.payments?.[0];

    if (!order) {
      return "Para seguir com o pagamento, primeiro precisamos finalizar o carrinho.";
    }

    if (!payment) {
      return this.confirmOrderAndCreatePayment(conversation);
    }

    if (payment.status === "PAID") {
      return [
        "Pagamento confirmado.",
        "",
        "Seu pedido já está sendo separado pela Raia Delivery.",
        "",
        "Entrega grátis por motoboy.",
        "Prazo estimado: até 30 minutos após a confirmação.",
      ].join("\n");
    }

    if (this.isAlreadyPaidCommand(text)) {
      return this.formatWaitingPaymentConfirmationReply();
    }

    const pixCopyPaste = payment.pixCopyPaste || payment.pixPayload;

    if (payment.provider === "pix_direct" && pixCopyPaste) {
      return this.formatPixResendReply(pixCopyPaste);
    }

    return this.confirmOrderAndCreatePayment(conversation);
  }

  private formatPixPaymentReply(
    totalCents: number,
    pixCopyPaste: string,
    _paymentUrl?: string,
  ) {
    const paymentInfo = [
      "Pedido confirmado.",
      "",
      `Total: ${this.formatCurrency(totalCents / 100)}`,
      "",
      "Vou te enviar o Pix Copia e Cola na próxima mensagem.",
      "",
      "O valor já está preenchido no código. Basta copiar e pagar.",
    ].join("\n");

    const deliveryInfo = [
      "Depois de pagar, responda “paguei” por aqui.",
      "Nossa equipe vai conferir e confirmar o pagamento.",
      "",
      "Entrega grátis por motoboy.",
      "Prazo estimado: até 30 minutos após a confirmação.",
    ];

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
        "O valor do pedido já está preenchido no código.",
      ].join("\n"),
      this.normalizePixCopyPaste(pixCopyPaste),
      "Depois de pagar, responda “paguei”. Nossa equipe vai conferir o pagamento.",
    ];
  }

  private formatWaitingPaymentConfirmationReply() {
    return [
      "Certo, recebi seu aviso.",
      "",
      "Para agilizar a conferência, envie uma foto ou PDF do comprovante por aqui.",
      "Nossa equipe vai conferir o Pix e confirmar o pedido pelo WhatsApp.",
    ].join("\n");
  }

  private formatPaymentProofRequestReply() {
    return [
      "Seu pedido está aguardando a confirmação do Pix.",
      "",
      "Se o pagamento já foi feito, envie uma foto ou PDF do comprovante para agilizar a conferência.",
      "Se precisar do código novamente, escreva “pix”.",
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

  private async handleSymptomMedicineQuestion(
    conversation: Conversation,
    symptom: SymptomMedicineRule,
  ) {
    this.logger.log(`INTENÇÃO POR SINTOMA DETECTADA: ${symptom.key}`);

    if (symptom.clarificationQuestion || symptom.candidates.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: `SYMPTOM:${symptom.key}`,
          pendingAction: ConversationState.IDLE,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return symptom.clarificationQuestion || "Me conte um pouco melhor o que você está sentindo para eu procurar a opção mais adequada.";
    }

    const options: CommercialMedicineOption[] = [];
    const consulted: string[] = [];

    for (const candidate of symptom.candidates) {
      consulted.push(candidate.medicineName);
      this.logger.log(
        `CONSULTANDO MEDICAMENTO POR SINTOMA: sintoma=${symptom.key} medicamento=${candidate.medicineName}`,
      );
      const summary = await this.medicineSearch.searchMedicine(candidate.medicineName);
      const option = summary?.options[0];

      if (!option) {
        this.logger.log(
          `MEDICAMENTO POR SINTOMA SEM RESULTADO: sintoma=${symptom.key} medicamento=${candidate.medicineName}`,
        );
        continue;
      }

      if (
        options.some(
          (item) =>
            this.normalize(item.label) === this.normalize(option.label) ||
            this.normalize(item.productName) === this.normalize(option.productName),
        )
      ) {
        continue;
      }

      options.push({
        ...option,
        optionId: options.length + 1,
        selectionReason: `sintoma ${symptom.key}: ${candidate.reason}`,
      });

      if (options.length >= 3) {
        break;
      }
    }

    this.logger.log(
      `RESULTADO BUSCA POR SINTOMA: sintoma=${symptom.key} consultados=${consulted.join(", ")} opcoes=${options.length}`,
    );

    if (options.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: `SYMPTOM:${symptom.key}`,
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });

      return [
        `Entendi. Não localizei uma opção comum para ${symptom.label} neste momento.`,
        "",
        this.aiService.canReadPackageImages?.()
          ? "Pode me dizer o nome do medicamento que procura ou enviar uma foto nítida da embalagem?"
          : "Pode me dizer o nome e a dosagem do medicamento que procura?",
      ].join("\n");
    }

    const shouldAskQuantity = options.length === 1;
    const selectedOption = shouldAskQuantity
      ? await this.ensureSelectedOptionPrice(options[0])
      : null;

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: `SYMPTOM:${symptom.key}`,
        pendingAction: shouldAskQuantity
          ? ConversationState.WAITING_QUANTITY
          : ConversationState.WAITING_PRESENTATION,
        lastMedicine: null,
        currentMedicineQuery: null,
        currentRetailCategory: null,
        candidateOptions: this.toJson(options),
        selectedPresentation: selectedOption
          ? this.toJson(selectedOption)
          : Prisma.JsonNull,
      },
    });

    if (selectedOption) {
      return [
        `Para ${symptom.label}, encontrei uma opção comum:`,
        "",
        this.formatSelectedOptionReply(selectedOption),
        symptom.safetyNote ? `\n${symptom.safetyNote}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    return this.formatSymptomOptionsReply(symptom, options);
  }

  private async handleCatalogSearchFailure(conversationId: string, status: string | undefined, query: string) {
    const reply = WhatsappCopy.catalogSearchProblem(status, this.bulaApiService.normalizeMedicineName(query) || query);
    if (!reply) return null;
    await this.prisma.conversation.update({ where: { id: conversationId }, data: {
      lastIntent: "CATALOG_UNAVAILABLE",
      pendingAction: ConversationState.WAITING_MEDICINE_NAME,
      currentMedicineQuery: query,
      selectedPresentation: Prisma.JsonNull, candidateOptions: Prisma.JsonNull,
    } });
    return reply;
  }

  private async handleMedicineQuestion(
    conversationId: string,
    question: MedicineQuestion,
  ) {
    const medicineName =
      this.bulaApiService.normalizeMedicineName(question.medicineName) ||
      question.medicineName;
    const searchQuery = question.searchQuery || medicineName;
    const spelling = medicineSpellingSuggestion(medicineName);
    if (spelling) {
      const spellingQuery = searchQuery.replace(new RegExp(`\\b${medicineName}\\b`, "i"), spelling);
      await this.prisma.conversation.update({ where: { id: conversationId }, data: {
        lastIntent: "WAITING_MEDICINE_SPELLING_CONFIRMATION",
        pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        currentMedicineQuery: null, currentRetailCategory: null, lastMedicine: null,
        selectedPresentation: Prisma.JsonNull, candidateOptions: this.toJson({ spellingQuery }),
      } });
      return `Você quis dizer ${spelling}? Confirme o nome para eu consultar sem trocar o medicamento por engano.\n\n1. Sim\n2. Não, vou escrever o nome da embalagem`;
    }
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

    const summary = await this.medicineSearch.searchMedicine(searchQuery);

    if (!summary) {
      return this.aiService.generatePharmacyReply(medicineName);
    }

    if (this.isInformationalMedicineIntent(question.intent)) {
      return this.formatMedicineInformationReply(question, summary);
    }

    if (summary.options.length === 0) {
      if (summary.retailFallbackQuery && summary.searchStatus === "not_found") {
        this.logger.log(JSON.stringify({ event: "CATALOG_ROUTING_FALLBACK", query: searchQuery,
          catalogQuery: summary.retailFallbackQuery, from: "medicine", to: "retail", reason: "catalog_contains_retail_products" }));
        return this.handleRetailProductQuestion(conversationId, searchQuery, { catalogQuery: summary.retailFallbackQuery });
      }
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
      return await this.handleCatalogSearchFailure(conversationId, summary.searchStatus || "not_found", searchQuery) ||
        (summary.searchStatus === "presentation_not_found" ? WhatsappCopy.medicinePresentationNotFound() :
          WhatsappCopy.medicineNotFound(this.aiService.canReadPackageImages?.() === true));
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
      catalogQuery?: string;
    },
  ) {
    const productQuery = this.extractRetailProductQuery(message);
    const categories = explicitRetailCategories(productQuery);
    if (categories.length > 1 && /\be\b|\+|,/i.test(message) && !/\b(?:kit|combo|conjunto|2\s*em\s*1)\b/.test(productQuery)) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          pendingAction: ConversationState.WAITING_MEDICINE_NAME, lastIntent: "RETAIL_MULTIPLE_PRODUCTS",
          currentMedicineQuery: null, currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull, candidateOptions: Prisma.JsonNull,
        },
      });
      return `Claro. Vamos começar por qual produto: ${categories.map(formatProductDisplayName).join(" ou ")}?`;
    }
    this.logger.log(`RETAIL PRODUCT QUERY: ${productQuery}`);
    const genericCategory =
      context?.category || this.productSearch.findGenericCategory(productQuery);
    const effectiveCategory =
      genericCategory || this.productSearch.findProductCategory?.(productQuery) || this.detectRetailCategoryFromQuery(productQuery);

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

    if (effectiveCategory === "fralda" && !/\b(?:infantil|bebe|crianca|adulto|geriatrica|pampers|huggies|pompom|pom pom|mamypoko|mamy poko)\b/.test(foldCustomerQuery(productQuery))) {
      await this.prisma.conversation.update({ where: { id: conversationId }, data: {
        lastIntent: "WAITING_DIAPER_AUDIENCE", pendingAction: ConversationState.WAITING_RETAIL_BRAND,
        currentMedicineQuery: productQuery, currentRetailCategory: "fralda",
        selectedPresentation: Prisma.JsonNull, candidateOptions: Prisma.JsonNull,
      } });
      return "A fralda é infantil ou para adulto?";
    }

    if (
      effectiveCategory &&
      this.productSearch.getPopularBrands(effectiveCategory).length > 0 &&
      !["gillette", "minancora"].includes(effectiveCategory) &&
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

    const summary = await this.productSearch.searchProducts(productQuery, context?.catalogQuery);
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

      return await this.handleCatalogSearchFailure(conversationId, orderedSummary.searchStatus || "not_found", productQuery) || WhatsappCopy.productNotFound(productQuery);
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

    const query = `${baseQuery} ${normalizeRetailSearchQuery(text)} ${attributeName} ${attributeValue}`;
    return this.handleRetailProductQuestion(conversation.id, query, {
      category: conversation.currentRetailCategory || undefined,
      selectedBrand: "atributo confirmado",
    });
  }

  private async handleFinalizeRequest(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Me diga o que você precisa que eu procuro para você.";
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
      "Me envie o CEP da entrega para eu continuar. Pode mandar apenas os 8 dígitos.",
    ].join("\n");
  }

  private formatCartStatus(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Me diga o que você precisa que eu procuro para você.";
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
      "Prazo estimado: até 30 minutos após a confirmação.",
    ].join("\n");
  }

  private async handleGlobalCancel(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      await this.resetConversationContext(conversation.id);
      return "Atendimento cancelado. Quando precisar, é só chamar a Raia Delivery por aqui.";
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastIntent: "WAITING_CANCEL_CART" },
    });

    return [
      "Você ainda tem itens no carrinho.",
      "",
      "Quer limpar o carrinho também?",
      "",
      "1. Sim, limpar carrinho",
      "2. Não, manter carrinho",
    ].join("\n");
  }

  private async handlePendingCancelCart(conversation: Conversation, text: string) {
    if (this.isConfirmChoice(text) || this.isPositiveConfirmation(text)) {
      await this.resetConversationContext(conversation.id);
      return "Carrinho limpo e atendimento cancelado. Quando precisar, é só chamar a Raia Delivery por aqui.";
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
        "Tudo bem, mantive seu carrinho salvo.",
        "",
        this.formatCartStatus(conversation),
      ].join("\n");
    }

    return "Responda 1 para limpar o carrinho ou 2 para manter.";
  }

  private async handleRemoveItemRequest(conversation: Conversation, text: string) {
    const cart = this.getCart(conversation.cart);

    if (cart.length === 0) {
      return "Seu carrinho ainda está vazio. Me diga o que você precisa que eu procuro para você.";
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
    if (conversation.lastIntent === "WAITING_PACKAGE_IMAGE_CONFIRMATION" &&
        conversation.pendingAction === ConversationState.WAITING_MEDICINE_NAME) {
      return this.handlePackageImageConfirmation(conversation, "2");
    }
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

    return "Tudo bem. Me diga qual produto você quer consultar.";
  }

  private async reopenCandidateOptions(conversation: Conversation) {
    const options = this.getCandidateOptions(conversation.candidateOptions);

    if (options.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_MEDICINE_NAME },
      });

      return "Tudo bem. Me diga qual outro produto você quer consultar.";
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
      return "No momento não encontrei outra opção disponível. Me diga qual produto você quer levar.";
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
        return `${option.optionId}. ${formatProductDisplayName(option.label)}${price}${option.source === "openai_web" && option.webQuote ? `\nFonte do preço: ${option.webQuote.sourceUrl}` : ""}`;
      })
      .join("\n");
  }

  private formatSymptomOptionsReply(
    symptom: SymptomMedicineRule,
    options: CommercialMedicineOption[],
  ) {
    const lines = [
      `Entendi. Para ${symptom.label}, encontrei estas opções comuns:`,
      "",
      this.formatCandidateOptions(options),
      "",
      "Me diga qual opção você quer consultar para eu separar no carrinho.",
      "",
      choicePrompt(),
    ];

    if (symptom.safetyNote) {
      lines.push("", symptom.safetyNote);
    }

    return lines.join("\n");
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
      `Encontrei ${presentation} para você.`,
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
    return normalizeRetailSearchQuery(message);
  }

  private isOnlyGenericRetailCategoryQuery(query: string, category: string) {
    return isGenericRetailCategoryQuery(query, category);
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

  private async handleDosageChangeFromContext(
    conversation: Conversation,
    text: string,
    selectedOption?: CommercialMedicineOption,
  ) {
    const dosage = this.extractDosageChange(text);

    if (!dosage) {
      return null;
    }

    const baseMedicine =
      conversation.currentMedicineQuery ||
      conversation.lastMedicine ||
      selectedOption?.medicineName ||
      selectedOption?.productName;

    if (!baseMedicine) {
      return null;
    }

    const namedMedicine = this.bulaApiService.normalizeMedicineName(text);
    // Fully named searches keep their form, pack size and commercial intent.
    if (namedMedicine) return null;
    if (dosage.needsUnit) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          selectedPresentation: Prisma.JsonNull, candidateOptions: Prisma.JsonNull,
        },
      });
      return "Pode enviar a dosagem com a unidade, como aparece na embalagem? Por exemplo: 50mg ou 50mcg. Elas são diferentes.";
    }

    this.logger.log(
      `TROCA DE DOSAGEM DETECTADA: medicamento=${baseMedicine} dosagem=${dosage.label}`,
    );
    const normalizedMedicine =
      this.bulaApiService.normalizeMedicineName(baseMedicine) || baseMedicine;
    const summary = await this.medicineSearch.searchMedicine(
      `${normalizedMedicine} ${text}`,
    );
    const matchingOptions = (summary?.options || [])
      .filter((option) => medicinePresentationStrengthMatches(option.strength || "", dosage.label, option.productName))
      .map((option, index) => ({ ...option, optionId: index + 1 }));

    if (matchingOptions.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          lastIntent: "DOSAGE_NOT_FOUND",
          currentMedicineQuery: normalizedMedicine,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });
      const searchProblem = await this.handleCatalogSearchFailure(conversation.id, summary?.searchStatus, `${normalizedMedicine} ${dosage.label}`);
      if (searchProblem) return searchProblem;
      const alternatives = (summary?.options || []).map((option, index) => ({
        ...option,
        optionId: index + 1,
      }));

      if (alternatives.length > 0) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            lastIntent: "DOSAGE_NOT_FOUND",
            pendingAction: ConversationState.WAITING_PRESENTATION,
            lastMedicine: normalizedMedicine,
            currentMedicineQuery: normalizedMedicine,
            currentRetailCategory: null,
            candidateOptions: this.toJson(alternatives),
            selectedPresentation: Prisma.JsonNull,
          },
        });

        return [
          `Não encontrei ${formatProductDisplayName(normalizedMedicine)} ${dosage.label}.`,
          "",
          "Encontrei estas opções em outras dosagens:",
          "",
          this.formatCandidateOptions(alternatives),
          "",
          choicePrompt(),
        ].join("\n");
      }

      return [
        `Não encontrei ${formatProductDisplayName(normalizedMedicine)} ${dosage.label} agora.`,
        "",
        this.aiService.canReadPackageImages?.()
          ? "Pode conferir a dosagem ou enviar uma foto nítida da embalagem?"
          : "Pode escrever a dosagem como aparece na embalagem?",
      ].join("\n");
    }

    if (matchingOptions.length > 1) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "DOSAGE_CHANGE",
          pendingAction: ConversationState.WAITING_PRESENTATION,
          lastMedicine: normalizedMedicine,
          currentMedicineQuery: normalizedMedicine,
          currentRetailCategory: null,
          candidateOptions: this.toJson(matchingOptions),
          selectedPresentation: Prisma.JsonNull,
        },
      });

      return [
        `Encontrei ${formatProductDisplayName(normalizedMedicine)} ${dosage.label}:`,
        "",
        this.formatCandidateOptions(matchingOptions),
        "",
        choicePrompt(),
      ].join("\n");
    }

    const selected = await this.ensureSelectedOptionPrice(matchingOptions[0]);

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: "DOSAGE_CHANGE",
        pendingAction: ConversationState.WAITING_QUANTITY,
        lastMedicine: normalizedMedicine,
        currentMedicineQuery: normalizedMedicine,
        currentRetailCategory: null,
        candidateOptions: this.toJson(matchingOptions),
        selectedPresentation: this.toJson(selected),
      },
    });

    return this.formatSelectedOptionReply(selected);
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
    if (catalogQuarantineReason(option)) return { ...option, pricePf: undefined };
    if (option.pricePolicy === CATALOG_PRICE_POLICY && option.source === "preco_popular") return option;
    if (option.source === "openai_web") {
      if (this.webMedicine?.isEnabled() && validWebQuote(option)) return option;
      const verified = option.webQuote ? await this.webMedicine?.revalidate(option.webQuote) : null;
      return verified && verified.sourceId === option.sourceId
        ? { ...option, pricePf: verified.salePrice, pricePolicy: WEB_MEDICINE_PRICE_POLICY, webQuote: verified.webQuote }
        : { ...option, pricePf: undefined };
    }
    const offer = await this.catalog?.findCurrentOffer(option);
    return offer ? {
      ...option, source: offer.source, sourceId: offer.sourceId, ean: offer.ean,
      pricePf: offer.price, pricePolicy: CATALOG_PRICE_POLICY,
    } : { ...option, pricePf: undefined };
  }

  private async refreshCheckoutPrices(conversation: Conversation) {
    const cart = this.getCart(conversation.cart).map((item) => ({ ...item }));
    if (this.extractConfirmedOrderId(conversation.lastIntent)) {
      return { cart, changed: false, error: null };
    }
    let changed = false;
    let quotesRefreshed = false;
    for (const [index, item] of cart.entries()) {
      if (catalogQuarantineReason(item)) {
        return { cart, changed: false, error: `O item ${index + 1} não está disponível para pedido no momento. Para continuar com os demais produtos, envie "remover item ${index + 1}". Mantive seu carrinho salvo.` };
      }
      if (item.pricePolicy === CATALOG_PRICE_POLICY && item.source === "preco_popular") continue;
      if (item.source === "openai_web") {
        const verified = item.webQuote ? await this.webMedicine?.revalidate(item.webQuote) : null;
        if (!verified?.salePrice || verified.sourceId !== item.sourceId) {
          return { cart, changed: false, error: `Não consegui confirmar o preço e a disponibilidade na fonte do item ${index + 1} (${formatProductDisplayName(item.name)}). Não gerei cobrança. Consulte esse produto novamente ou remova com "remover item ${index + 1}". Mantive seu carrinho salvo.` };
        }
        changed ||= Math.round((item.unitPrice || 0) * 100) !== Math.round(verified.salePrice * 100);
        Object.assign(item, { unitPrice: verified.salePrice, total: Number((verified.salePrice * item.quantity).toFixed(2)),
          pricePolicy: WEB_MEDICINE_PRICE_POLICY, webQuote: verified.webQuote });
        quotesRefreshed = true;
        continue;
      }
      const offer = await this.catalog?.findCurrentOffer(item);
      if (!offer) {
        return { cart, changed: false, error:
          `Não consegui atualizar o item ${index + 1} (${formatProductDisplayName(item.name)}). Para continuar, remova esse item com "remover item ${index + 1}" e consulte o produto novamente. Mantive seu carrinho salvo.` };
      }
      Object.assign(item, {
        source: offer.source, sourceId: offer.sourceId, ean: offer.ean,
        unitPrice: offer.price, total: Number((offer.price * item.quantity).toFixed(2)),
        pricePolicy: CATALOG_PRICE_POLICY,
      });
      changed = true;
    }
    if (changed || quotesRefreshed) {
      await this.prisma.conversation.update({
        where: { id: conversation.id }, data: { cart: this.toJson(cart) },
      });
    }
    return { cart, changed, error: null };
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
        ? `O valor dessa opção é ${this.formatCurrency(option.pricePf)}.`
        : this.formatMissingPrice(option);
    } else if (
      /\b(quantos|vem quantos|qual embalagem|embalagem)\b/.test(normalized)
    ) {
      answer = option.packageDescription
        ? `Essa embalagem vem com ${option.packageDescription.replace(/^caixa com\s+/i, "")}.`
        : "Não encontrei a embalagem detalhada dessa apresentação.";
    } else if (
      /\b(comprimido|comprimidos|capsula|capsulas|gotas)\b/.test(normalized)
    ) {
      answer = `Essa apresentação é ${this.formatPresentationText(option.formGroup)}.`;
    } else {
      answer = option.packageDescription
        ? `Essa embalagem vem com ${option.packageDescription.replace(/^caixa com\s+/i, "")}.`
        : "Não encontrei a embalagem detalhada dessa apresentação.";
    }

    return [answer, "", this.repeatStatePrompt(state)].join("\n");
  }

  private answerCurrentItemPrice(
    option: CommercialMedicineOption,
    state: ConversationState,
  ) {
    const answer = option.pricePf
      ? `O valor dessa opção é ${this.formatCurrency(option.pricePf)}.`
      : this.formatMissingPrice(option);

    return [answer, "", this.repeatStatePrompt(state)].join("\n");
  }

  private formatOrderConfirmation(
    conversation: { cart: unknown },
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
      pricePolicy: option.pricePolicy,
      webQuote: option.webQuote,
      quantity,
      total,
      imageUrl: option.imageUrl,
      source: option.source || option.selectionReason,
      sourceId: option.sourceId,
      ean: option.ean,
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
        "label" in option &&
        !catalogQuarantineReason(option)
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
      if (catalogQuarantineReason(value as unknown as CommercialMedicineOption)) return null;
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

  private extractDosageChange(text: string) {
    const normalized = this.normalize(text);
    const strengths = extractMedicineStrengths(normalized);
    if (strengths.length) return { label: strengths.map((strength) => strength.label).join(" + "), needsUnit: false };
    const inferred = normalized.match(/^(?:(?:tem|teria|quero|e|nao tem)\s+)?(?:de|com)\s*(\d{1,4})\s*[?!.]*$/);
    const match = inferred;

    if (!match) {
      return null;
    }

    const value = Number(match[1].replace(",", "."));

    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    return {
      label: String(value), needsUnit: true,
    };
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
      return "Está tudo certo para confirmar?\n\n1. Confirmar pedido\n2. Adicionar mais produtos\n3. Cancelar";
    }

    return "Me diga o que você precisa que eu procuro para você.";
  }

  private async handleGreeting(conversation: Conversation) {
    const cart = this.getCart(conversation.cart);

    if (conversation.pendingAction !== ConversationState.IDLE) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: cart.length > 0 ? conversation.lastIntent : null,
          pendingAction: ConversationState.IDLE,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
        },
      });
    }

    if (cart.length > 0) {
      return WhatsappCopy.welcomeWithCart();
    }

    return WhatsappCopy.welcome();
  }

  private async handleOrderOpening(conversation: Conversation) {
    const hasCart = this.getCart(conversation.cart).length > 0;
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastIntent: "START_ORDER",
        pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        lastMedicine: null,
        currentMedicineQuery: null,
        currentRetailCategory: null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
      },
    });
    this.logger.log("CONVERSATION INTENT: START_ORDER_WITHOUT_PRODUCT");
    return WhatsappCopy.startOrder(hasCart);
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
    const normalized = normalizeRetailSearchQuery(text);
    const match = normalized.match(/\b(?:fps|spf)\s*(\d{1,3})\b/) || normalized.trim().match(/^(\d{1,3})$/);
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
    return value.trim().replace(/[\r\n\t]/g, "");
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
