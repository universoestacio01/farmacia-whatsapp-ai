import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  backupEnabled,
  BULAPI_BASE_URL,
} from "../config/medicine-backups.config";
import { sanitizeEnv } from "../config/env-sanitize";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { NormalizedMedicineOption } from "./medicine-provider.interface";
import { providerFailure } from "../utils/provider-failure.util";
import {
  medicineStrengthMatches,
  medicineStrengthSignature,
  removeMedicineStrengths,
} from "../utils/medicine-strength.util";

type Row = Record<string, unknown>;
interface Result {
  failureReason?: string;
  statusCode?: number;
  options: NormalizedMedicineOption[];
  status: "ok" | "incomplete" | "unavailable" | "disabled";
}
interface Budget {
  deadline: number;
  calls: number;
}

@Injectable()
export class BulapiCatalogService {
  readonly name = "bulapi" as const;
  private readonly logger = new Logger(BulapiCatalogService.name);
  private readonly cache = new Map<
    string,
    { expires: number; result: Result }
  >();
  private readonly pending = new Map<string, Promise<Result>>();
  private unavailableUntil = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly selector: CommercialMedicineSelector,
  ) {}

  isEnabled() {
    return backupEnabled(this.config.get("BULAPI_ENABLED"));
  }

  async searchWithStatus(query: string): Promise<Result> {
    if (!this.isEnabled()) return { options: [], status: "disabled" };
    const parsed = this.selector.parseMedicineQuery(query);
    const term = parsed.medicineName || query;
    const cached = this.cache.get(query);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (Date.now() < this.unavailableUntil)
      return { options: [], status: "unavailable", failureReason: "provider_cooldown" };
    if (this.pending.has(query)) return this.pending.get(query)!;
    const request = this.searchCatalog(term, query)
      .then((result) => {
        if (result.status === "ok" || result.status === "incomplete") {
          if (this.cache.size >= 200)
            this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(query, {
            result,
            expires: Date.now() + (result.options.length ? 300_000 : 60_000),
          });
        }
        return result;
      })
      .finally(() => this.pending.delete(query));
    this.pending.set(query, request);
    return request;
  }

  private async searchCatalog(term: string, query: string): Promise<Result> {
    const budget = { deadline: Date.now() + 6000, calls: 0 };
    try {
      const search = this.row(
        await this.request(`/search?q=${encodeURIComponent(term)}`, budget),
      );
      const data = this.row(search.data);
      if (!Array.isArray(data.products))
        throw new Error("BulAPI invalid search response");
      const products = data.products
        .map((item) => this.row(item))
        .filter(
          (product) =>
            typeof product.name === "string" &&
            this.selector.isSameMedicine(term, {
              id: Number(product.id),
              name: product.name,
              substance: {
                name: this.string(this.row(product.substance).name),
              },
            }),
        );
      const options: NormalizedMedicineOption[] = [];
      let incomplete = products.length > 3;
      // A lookup costs at most 9 HTTP requests, including three price lookups.
      for (const product of products.slice(0, 3)) {
        const seen = new Set<string>();
        for (let page = 1; page <= 2 && budget.calls < 6; page++) {
          const response = this.row(
            await this.request(
              `/products/${encodeURIComponent(String(product.id))}/presentations?per_page=100&page=${page}`,
              budget,
            ),
          );
          if (!Array.isArray(response.data))
            throw new Error("BulAPI invalid presentations response");
          const signature = JSON.stringify(
            response.data.map((item) => this.row(item).id),
          );
          if (seen.has(signature)) {
            incomplete = true;
            break;
          }
          seen.add(signature);
          for (const value of response.data) {
            const item = this.row(value);
            if (item.active === false || item.is_active === false) continue;
            const presentation = [
              item.strength,
              item.dose_form,
              item.route,
              item.package_description,
            ]
              .filter((part) => typeof part === "string")
              .join(" ");
            const info = this.selector.extractPackageInfo(
              removeMedicineStrengths(presentation),
            );
            options.push({
              source: "bulapi",
              sourceId: String(item.id),
              productName: String(product.name),
              displayName: String(product.name),
              substance: this.string(this.row(product.substance).name),
              brand: String(product.name),
              dosage: this.string(item.strength),
              form: this.string(item.dose_form),
              presentation,
              ean: this.string(item.ean || item.ean_1),
              packageInfo: {
                raw: presentation,
                unitCount: this.number(item.package_quantity) || info.unitCount,
                volumeMl: info.volumeMl,
                isInjectable: info.isInjectable,
                isHospitalUse: info.isHospitalUse,
              },
              availabilityStatus: "unknown",
            });
          }
          const meta = this.row(response.meta);
          const lastPage = this.number(meta.last_page);
          if (lastPage ? page >= lastPage : response.data.length < 100) break;
          if (page === 2 || budget.calls >= 6) incomplete = true;
        }
      }
      const parsed = this.selector.parseMedicineQuery(query);
      const candidates = options.filter(
        (option) =>
          !option.packageInfo?.isInjectable &&
          !option.packageInfo?.isHospitalUse &&
          (!parsed.dosage ||
            medicineStrengthMatches(option.dosage || "", parsed.dosage)) &&
          (!parsed.formGroup ||
            this.selector.extractPackageInfo(option.presentation || "")
              .formGroup === parsed.formGroup) &&
          (parsed.packageQuantity === undefined ||
            option.packageInfo?.unitCount === parsed.packageQuantity),
      );
      // Spend the price budget on distinct doses first, then other presentations.
      const unique = [
        ...new Map(
          candidates.map((item) => [
            `${medicineStrengthSignature(item.dosage || "")}|${this.selector.extractPackageInfo(item.presentation || "").formGroup}|${item.packageInfo?.unitCount}|${item.packageInfo?.volumeMl}`,
            item,
          ]),
        ).values(),
      ];
      const doses = new Set<string>();
      const priced: NormalizedMedicineOption[] = [];
      for (const item of unique) {
        const dose = medicineStrengthSignature(item.dosage || "");
        if (doses.has(dose)) continue;
        doses.add(dose);
        priced.push(item);
        if (priced.length === 3) break;
      }
      for (const item of unique) {
        if (priced.length === 3) break;
        if (!priced.includes(item)) priced.push(item);
      }
      for (const option of priced) {
        const response = this.row(
          await this.request(
            `/presentations/${encodeURIComponent(option.sourceId!)}/prices`,
            budget,
          ),
        );
        if (!Array.isArray(response.data))
          throw new Error("BulAPI invalid price response");
        const prices = response.data
          .flatMap((item) => Object.values(this.row(this.row(item).pf_prices)))
          .map((value) => this.number(value))
          .filter((value): value is number => value !== undefined && value > 0);
        option.priceFactory = prices.length ? Math.max(...prices) : undefined;
      }
      return { options: priced, status: incomplete ? "incomplete" : "ok" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      this.unavailableUntil =
        Date.now() + (/429/.test(reason) ? 300_000 : 60_000);
      this.logger.warn(
        JSON.stringify({
          provider: this.name,
          event: "BACKUP_FAILED",
          query,
          reason,
        }),
      );
      return { options: [], status: "unavailable", ...providerFailure(error) };
    }
  }

  private async request(path: string, budget: Budget): Promise<unknown> {
    if (++budget.calls > 9 || Date.now() >= budget.deadline)
      throw new Error("BulAPI request budget exhausted");
    const base = (
      sanitizeEnv(this.config.get("BULA_API_BASE_URL")) || BULAPI_BASE_URL
    ).replace(/\/$/, "");
    const response = await fetch(`${base}${path}`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(2500, Math.max(1, budget.deadline - Date.now())),
      ),
    });
    this.logger.log(
      JSON.stringify({
        provider: this.name,
        endpoint: path,
        status: response.status,
      }),
    );
    if (!response.ok) throw new Error(`BulAPI HTTP ${response.status}`);
    return response.json();
  }
  private row(value: unknown): Row {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Row)
      : {};
  }
  private string(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  private number(value: unknown) {
    if (
      typeof value !== "number" &&
      (typeof value !== "string" || !value.trim())
    )
      return undefined;
    const number = Number(String(value).replace(",", "."));
    return Number.isFinite(number) ? number : undefined;
  }
}
