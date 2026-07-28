import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  DEFAULT_MEDICINE_PRIORITY_RULES,
  MedicinePriorityRuleConfig,
} from "../config/medicine-priority-rules.config";
import { PrismaService } from "../prisma/prisma.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";

@Injectable()
export class MedicinePriorityRulesService {
  private readonly logger = new Logger(MedicinePriorityRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly selector: CommercialMedicineSelector,
  ) {}

  async getRulesForPrinciple(principleActive: string) {
    const normalized = this.normalizePrinciple(principleActive);
    const dbRules = await this.prisma.safePrismaCall(
      "medicine_priority_rules.findMany.runtime",
      (prisma) =>
        prisma.medicinePriorityRule.findMany({
          where: { principleActive: normalized, enabled: true },
          orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        }),
      [],
    );

    if (dbRules.length > 0) {
      return dbRules.map((rule) => this.toConfig(rule));
    }

    return DEFAULT_MEDICINE_PRIORITY_RULES.filter(
      (rule) => this.normalizePrinciple(rule.principleActive) === normalized,
    );
  }

  async listAll() {
    const dbRules = await this.prisma.safePrismaCall(
      "medicine_priority_rules.findMany.admin",
      (prisma) =>
        prisma.medicinePriorityRule.findMany({
          orderBy: [{ principleActive: "asc" }, { priority: "desc" }],
        }),
      [],
    );

    return {
      source: dbRules.length > 0 ? "database" : "default",
      rules:
        dbRules.length > 0
          ? dbRules.map((rule) => this.toConfig(rule, rule.id))
          : DEFAULT_MEDICINE_PRIORITY_RULES.map((rule) => ({ ...rule, enabled: true })),
    };
  }

  async replaceRules(rules: MedicinePriorityRuleConfig[]) {
    const normalizedRules = rules
      .map((rule) => this.normalizeInputRule(rule))
      .filter((rule): rule is MedicinePriorityRuleConfig => Boolean(rule));

    await this.prisma.safePrismaCall("medicine_priority_rules.replace", (prisma) =>
      prisma.$transaction([
        prisma.medicinePriorityRule.deleteMany(),
        prisma.medicinePriorityRule.createMany({
          data: normalizedRules.map((rule) => ({
            principleActive: rule.principleActive,
            dosageMg: rule.dosageMg,
            dosageText: rule.dosageText,
            quantity: rule.quantity,
            formGroup: rule.formGroup,
            brand: rule.brand,
            priority: rule.priority,
            enabled: rule.enabled ?? true,
          })),
        }),
      ]),
    );

    this.logger.log(`Prioridades de medicamentos atualizadas: ${normalizedRules.length}`);
    return this.listAll();
  }

  private normalizeInputRule(
    rule: MedicinePriorityRuleConfig,
  ): MedicinePriorityRuleConfig | null {
    const principleActive = this.normalizePrinciple(rule.principleActive);

    if (!principleActive) {
      return null;
    }

    return {
      principleActive,
      dosageMg: this.positiveInteger(rule.dosageMg),
      dosageText: this.cleanOptional(rule.dosageText),
      quantity: this.positiveInteger(rule.quantity),
      formGroup: this.cleanOptional(rule.formGroup),
      brand: this.cleanOptional(rule.brand),
      priority: this.positiveInteger(rule.priority) ?? 100,
      enabled: rule.enabled ?? true,
    };
  }

  private toConfig(
    rule: Prisma.MedicinePriorityRuleGetPayload<Record<string, never>>,
    id?: string,
  ) {
    return {
      id,
      principleActive: rule.principleActive,
      dosageMg: rule.dosageMg ?? undefined,
      dosageText: rule.dosageText ?? undefined,
      quantity: rule.quantity ?? undefined,
      formGroup: rule.formGroup ?? undefined,
      brand: rule.brand ?? undefined,
      priority: rule.priority,
      enabled: rule.enabled,
    };
  }

  private normalizePrinciple(value: string) {
    return this.selector.getCanonicalMedicineName(value || "").trim();
  }

  private cleanOptional(value: string | undefined) {
    const cleaned = value?.trim();
    return cleaned || undefined;
  }

  private positiveInteger(value: number | undefined) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  }
}
