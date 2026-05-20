import { Injectable } from '@nestjs/common';
import {
  BillingConfigService,
  VolumeDiscountTier,
} from './billing-config.service';

export type ResolvedPricing = {
  unitPrice: number;
  baseUnitPrice: number;
  currency: string;
  discountPercent: number;
  volumeDiscount: VolumeDiscountTier | null;
};

@Injectable()
export class PricingService {
  private readonly defaultCurrency = 'USD';
  private readonly dynamicPricingEnabled =
    process.env.ENABLE_DYNAMIC_PRICING === 'true';

  constructor(private readonly billingConfig: BillingConfigService) {}

  async getPricing(
    product: string,
    units = 1,
    revision?: string,
  ): Promise<ResolvedPricing> {
    const defaultPrice = await this.billingConfig.getNumber(
      'unit_price.default',
      0.5,
    );
    const baseUnitPrice = this.dynamicPricingEnabled
      ? await this.resolveBaseUnitPrice(product, revision, defaultPrice)
      : defaultPrice;
    const volumeDiscount = this.dynamicPricingEnabled
      ? await this.getVolumeDiscount(units)
      : null;
    const discountPercent = volumeDiscount?.discountPercent ?? 0;
    const unitPrice = this.applyDiscount(baseUnitPrice, discountPercent);

    return {
      unitPrice,
      baseUnitPrice,
      currency: this.defaultCurrency,
      discountPercent,
      volumeDiscount,
    };
  }

  async getUnitPrice(
    product: string,
    units = 1,
    revision?: string,
  ): Promise<number> {
    const pricing = await this.getPricing(product, units, revision);
    return pricing.unitPrice;
  }

  async getUnitPriceForBarcodeType(
    type: 'PDF417' | 'CODE128',
    units = 1,
    revision?: string,
  ): Promise<number> {
    return await this.getUnitPrice(
      type === 'PDF417' ? 'barcode_pdf417' : 'barcode_code128',
      units,
      revision,
    );
  }

  private async resolveBaseUnitPrice(
    product: string,
    revision: string | undefined,
    defaultPrice: number,
  ): Promise<number> {
    const productPrice = await this.billingConfig.getNumber(
      `unit_price.by_product.${product}`,
      defaultPrice,
    );

    if (!revision) {
      return productPrice;
    }

    const normalizedRevision = this.normalizeConfigKeySegment(revision);
    const revisionPrice = await this.billingConfig.getNumber(
      `unit_price.by_revision.${normalizedRevision}`,
      productPrice,
    );

    return await this.billingConfig.getNumber(
      `unit_price.by_product_revision.${product}.${normalizedRevision}`,
      revisionPrice,
    );
  }

  private async getVolumeDiscount(
    units: number,
  ): Promise<VolumeDiscountTier | null> {
    if (!Number.isInteger(units) || units < 1) {
      return null;
    }

    const discounts = await this.billingConfig.getVolumeDiscounts();

    return (
      discounts.find((discount) => {
        const withinLowerBound = units >= discount.minUnits;
        const withinUpperBound =
          discount.maxUnits === null || units <= discount.maxUnits;

        return withinLowerBound && withinUpperBound;
      }) ?? null
    );
  }

  private applyDiscount(
    baseUnitPrice: number,
    discountPercent: number,
  ): number {
    const baseUnitPriceCents = Math.round(baseUnitPrice * 100);
    const discountedUnitPriceCents = Math.round(
      (baseUnitPriceCents * (100 - discountPercent)) / 100,
    );

    return discountedUnitPriceCents / 100;
  }

  private normalizeConfigKeySegment(value: string): string {
    return value.trim().replace(/\./g, '_').replace(/\s+/g, '_');
  }
}
