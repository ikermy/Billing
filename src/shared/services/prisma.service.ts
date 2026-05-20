import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PackageDto } from 'src/product/dto/package.dto';
import { ProductWithPackages } from 'src/shared/types/billing.types';

type PackageItem = { credits: number; price: number };
type RawPackage = { credits: unknown; price: unknown };

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async getBarcodePackages() {
    const product = await this.product.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    if (!product) {
      throw new Error('No barcode product found');
    }

    return {
      packages: this.parsePackages(product.packages, product.name),
      product,
    };
  }

  extractPackages(product: ProductWithPackages): Promise<{
    packages: PackageItem[];
    product: ProductWithPackages;
  }> {
    return Promise.resolve({
      packages: this.parsePackages(product.packages, product.name),
      product,
    });
  }

  public packagesToJSON(
    packages: PackageDto[] | undefined,
  ): Prisma.JsonArray | undefined {
    if (!packages) return undefined;
    return packages.map((p) => ({
      credits: p.credits,
      price: p.price,
    }));
  }

  private parsePackages(raw: unknown, productName: string): PackageItem[] {
    let packages: unknown;

    try {
      packages = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      this.logger.error(`Error parsing packages for product: ${productName}`);
      throw new Error(`Invalid packages JSON for product=${productName}`);
    }

    if (!Array.isArray(packages) || packages.length === 0) {
      this.logger.error(`Package is empty for product=${productName}`);
      throw new Error(`Empty packages for product=${productName}`);
    }

    const normalized = packages.map((item) => {
      if (!this.isRawPackage(item)) {
        this.logger.error(`Invalid package schema for product=${productName}`);
        throw new Error(`Invalid package schema for product=${productName}`);
      }

      return {
        credits: Number(item.credits),
        price: Number(item.price),
      };
    });

    const isInvalid = normalized.some(
      (item) =>
        !Number.isInteger(item.credits) ||
        item.credits < 0 ||
        !Number.isFinite(item.price) ||
        item.price < 0,
    );

    if (isInvalid) {
      this.logger.error(`Invalid package schema for product=${productName}`);
      throw new Error(`Invalid package schema for product=${productName}`);
    }

    return normalized;
  }

  private isRawPackage(value: unknown): value is RawPackage {
    return (
      typeof value === 'object' &&
      value !== null &&
      'credits' in value &&
      'price' in value
    );
  }
}
