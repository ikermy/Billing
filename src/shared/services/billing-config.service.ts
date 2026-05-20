import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, BillingConfig } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { normalizeJsonValue } from 'src/shared/utils/json.util';

export type VolumeDiscountTier = {
  id: string;
  minUnits: number;
  maxUnits: number | null;
  discountPercent: number;
  isActive: boolean;
};

export type TopUpBonusTier = {
  minAmount: number;
  maxAmount: number | null;
  bonusPercent: number;
};

const DEFAULT_VOLUME_DISCOUNTS: VolumeDiscountTier[] = [
  {
    id: 'volume-default-100',
    minUnits: 100,
    maxUnits: 499,
    discountPercent: 5,
    isActive: true,
  },
  {
    id: 'volume-default-500',
    minUnits: 500,
    maxUnits: 999,
    discountPercent: 10,
    isActive: true,
  },
  {
    id: 'volume-default-1000',
    minUnits: 1000,
    maxUnits: null,
    discountPercent: 15,
    isActive: true,
  },
];

const DEFAULT_TOPUP_BONUS_TIERS: TopUpBonusTier[] = [
  {
    minAmount: 50,
    maxAmount: 99.99,
    bonusPercent: 10,
  },
  {
    minAmount: 100,
    maxAmount: null,
    bonusPercent: 15,
  },
];

export const DEFAULT_BILLING_CONFIG: Record<string, Prisma.JsonValue> = {
  'unit_price.default': 0.5,
  'unit_price.by_product.barcode_pdf417': 0.5,
  'unit_price.by_product.barcode_code128': 0.3,
  volume_discounts: DEFAULT_VOLUME_DISCOUNTS,
  saga_timeout_minutes: 5,
  'topup_bonus.tiers': DEFAULT_TOPUP_BONUS_TIERS,
  'waived.limit_per_day': 5,
  'waived.window_seconds': 24 * 60 * 60,
  'referral.referrer_bonus': 5,
  'referral.referred_bonus': 3,
};

type CachedBillingConfigEntry = {
  exists: boolean;
  value: Prisma.JsonValue | null;
};

@Injectable()
export class BillingConfigService {
  private readonly configCacheTtlSeconds = 60;
  private readonly effectiveConfigCacheKey = 'billing:config:effective';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getValue(
    key: string,
    fallback?: Prisma.JsonValue,
  ): Promise<Prisma.JsonValue | undefined> {
    const cacheKey = this.getConfigCacheKey(key);
    const cached = await this.redis.getJson<CachedBillingConfigEntry>(cacheKey);
    if (cached) {
      return cached.exists ? (cached.value ?? null) : fallback;
    }

    const config = await this.prisma.billingConfig.findUnique({
      where: { key },
    });

    await this.redis.set(
      cacheKey,
      {
        exists: Boolean(config),
        value: config?.value ?? null,
      } satisfies CachedBillingConfigEntry,
      this.configCacheTtlSeconds,
    );

    return config?.value ?? fallback;
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const value = await this.getValue(key, fallback);
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async getVolumeDiscounts(): Promise<VolumeDiscountTier[]> {
    const discounts = await this.listVolumeDiscounts();
    return discounts.filter((item) => item.isActive);
  }

  async listVolumeDiscounts(): Promise<VolumeDiscountTier[]> {
    const raw = await this.getValue(
      'volume_discounts',
      DEFAULT_BILLING_CONFIG.volume_discounts,
    );

    if (!Array.isArray(raw)) {
      return DEFAULT_VOLUME_DISCOUNTS;
    }

    const tiers = raw
      .map((item): VolumeDiscountTier | null => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const record = item as Record<string, unknown>;
        const minUnits = Number(record.minUnits);
        const maxUnits =
          record.maxUnits === null || record.maxUnits === undefined
            ? null
            : Number(record.maxUnits);
        const discountPercent = Number(record.discountPercent);
        const id =
          typeof record.id === 'string' && record.id.trim().length > 0
            ? record.id
            : `volume-${minUnits}-${maxUnits ?? 'null'}-${discountPercent}`;
        const isActive =
          record.isActive === undefined ? true : Boolean(record.isActive);

        if (
          !Number.isInteger(minUnits) ||
          minUnits < 1 ||
          !Number.isFinite(discountPercent) ||
          discountPercent < 0
        ) {
          return null;
        }

        if (
          maxUnits !== null &&
          (!Number.isInteger(maxUnits) || maxUnits < minUnits)
        ) {
          return null;
        }

        return {
          id,
          minUnits,
          maxUnits,
          discountPercent,
          isActive,
        };
      })
      .filter((item): item is VolumeDiscountTier => item !== null)
      .sort((left, right) => left.minUnits - right.minUnits);

    return tiers.length > 0 ? tiers : DEFAULT_VOLUME_DISCOUNTS;
  }

  async createVolumeDiscount(
    input: Omit<VolumeDiscountTier, 'id' | 'isActive'> & { isActive?: boolean },
    updatedBy?: string,
  ): Promise<VolumeDiscountTier> {
    const discounts = await this.listVolumeDiscounts();
    const discount = this.validateVolumeDiscount({
      id: randomUUID(),
      minUnits: input.minUnits,
      maxUnits: input.maxUnits,
      discountPercent: input.discountPercent,
      isActive: input.isActive ?? true,
    });

    await this.setValue(
      'volume_discounts',
      [...discounts, discount],
      updatedBy,
    );

    return discount;
  }

  async updateVolumeDiscount(
    id: string,
    input: Partial<Omit<VolumeDiscountTier, 'id'>>,
    updatedBy?: string,
  ): Promise<VolumeDiscountTier> {
    const discounts = await this.listVolumeDiscounts();
    const existing = discounts.find((item) => item.id === id);

    if (!existing) {
      throw new NotFoundException('Volume discount not found');
    }

    const updated = this.validateVolumeDiscount({
      ...existing,
      ...input,
      id,
    });

    await this.setValue(
      'volume_discounts',
      discounts.map((item) => (item.id === id ? updated : item)),
      updatedBy,
    );

    return updated;
  }

  async deactivateVolumeDiscount(
    id: string,
    updatedBy?: string,
  ): Promise<VolumeDiscountTier> {
    return await this.updateVolumeDiscount(
      id,
      {
        isActive: false,
      },
      updatedBy,
    );
  }

  async getTopUpBonusTiers(): Promise<TopUpBonusTier[]> {
    const raw = await this.getValue(
      'topup_bonus.tiers',
      DEFAULT_BILLING_CONFIG['topup_bonus.tiers'],
    );

    if (!Array.isArray(raw)) {
      return DEFAULT_TOPUP_BONUS_TIERS;
    }

    const tiers = raw
      .map((item): TopUpBonusTier | null => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const record = item as Record<string, unknown>;
        const minAmount = Number(record.minAmount);
        const maxAmount =
          record.maxAmount === null || record.maxAmount === undefined
            ? null
            : Number(record.maxAmount);
        const bonusPercent = Number(record.bonusPercent);

        if (
          !Number.isFinite(minAmount) ||
          minAmount < 0 ||
          !Number.isFinite(bonusPercent) ||
          bonusPercent < 0
        ) {
          return null;
        }

        if (
          maxAmount !== null &&
          (!Number.isFinite(maxAmount) || maxAmount < minAmount)
        ) {
          return null;
        }

        return {
          minAmount,
          maxAmount,
          bonusPercent,
        };
      })
      .filter((item): item is TopUpBonusTier => item !== null)
      .sort((left, right) => left.minAmount - right.minAmount);

    return tiers.length > 0 ? tiers : DEFAULT_TOPUP_BONUS_TIERS;
  }

  async getTopUpBonusPercent(amount: number): Promise<number> {
    if (!Number.isFinite(amount) || amount <= 0) {
      return 0;
    }

    const tiers = await this.getTopUpBonusTiers();
    const tier = tiers.find((item) => {
      const withinLowerBound = amount >= item.minAmount;
      const withinUpperBound =
        item.maxAmount === null || amount <= item.maxAmount;

      return withinLowerBound && withinUpperBound;
    });

    return tier?.bonusPercent ?? 0;
  }

  async getWaivedLimit(): Promise<number> {
    const limit = await this.getNumber(
      'waived.limit_per_day',
      Number(DEFAULT_BILLING_CONFIG['waived.limit_per_day']),
    );

    return Number.isInteger(limit) && limit > 0 ? limit : 5;
  }

  async getWaivedWindowSeconds(): Promise<number> {
    const ttl = await this.getNumber(
      'waived.window_seconds',
      Number(DEFAULT_BILLING_CONFIG['waived.window_seconds']),
    );

    return Number.isInteger(ttl) && ttl > 0 ? ttl : 24 * 60 * 60;
  }

  async listEffectiveConfig(): Promise<Record<string, Prisma.JsonValue>> {
    const cached = await this.redis.getJson<Record<string, Prisma.JsonValue>>(
      this.effectiveConfigCacheKey,
    );
    if (cached) {
      return cached;
    }

    const configs = await this.prisma.billingConfig.findMany({
      orderBy: { key: 'asc' },
    });

    const effectiveConfig = configs.reduce<Record<string, Prisma.JsonValue>>(
      (acc, item) => {
        acc[item.key] = item.value;
        return acc;
      },
      { ...DEFAULT_BILLING_CONFIG },
    );

    await this.redis.set(
      this.effectiveConfigCacheKey,
      effectiveConfig,
      this.configCacheTtlSeconds,
    );

    return effectiveConfig;
  }

  async setValue(
    key: string,
    value: unknown,
    updatedBy?: string,
  ): Promise<BillingConfig> {
    const normalizedValue = normalizeJsonValue(
      value,
      'Billing config value must be valid JSON',
    );

    const config = await this.prisma.billingConfig.upsert({
      where: { key },
      update: {
        value: normalizedValue,
        updatedBy,
      },
      create: {
        key,
        value: normalizedValue,
        updatedBy,
      },
    });

    await this.redis.del(
      this.getConfigCacheKey(key),
      this.effectiveConfigCacheKey,
    );

    return config;
  }

  private getConfigCacheKey(key: string): string {
    return `billing:config:key:${key}`;
  }

  private validateVolumeDiscount(
    input: VolumeDiscountTier,
  ): VolumeDiscountTier {
    if (!Number.isInteger(input.minUnits) || input.minUnits < 1) {
      throw new BadRequestException('Volume discount minUnits must be >= 1');
    }

    if (
      input.maxUnits !== null &&
      (!Number.isInteger(input.maxUnits) || input.maxUnits < input.minUnits)
    ) {
      throw new BadRequestException(
        'Volume discount maxUnits must be null or >= minUnits',
      );
    }

    if (
      !Number.isFinite(input.discountPercent) ||
      input.discountPercent < 0 ||
      input.discountPercent > 100
    ) {
      throw new BadRequestException(
        'Volume discount percent must be between 0 and 100',
      );
    }

    return input;
  }
}
