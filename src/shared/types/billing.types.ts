import type { Product } from '@prisma/client';

export type ProductWithPackages = Pick<Product, 'id' | 'name' | 'packages'>;

export type CachedPlan = {
  name: string;
  description?: string | null;
  code: string;
  interval?: string | null;
  payInAdvance?: boolean;
  amountCents: number;
  amountCurrency?: string | null;
  trialPeriod?: number | null;
  charges?: unknown[];
};

export type CachedCoupon = {
  name: string;
  description?: string | null;
  code: string;
  type: string;
  planCodes?: string[] | null;
  amountCents?: number | null;
  reusable?: boolean;
  percentageRate?: string | null;
  frequency?: string | null;
  frequencyDuration?: number | null;
  expirationAt?: string | null;
};
