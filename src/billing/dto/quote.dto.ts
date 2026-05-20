import { CreditType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export { CreditType };

export enum QuoteSource {
  SINGLE = 'single',
  BULK = 'bulk',
}

export class QuoteContextDto {
  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsString()
  revision?: string;

  @IsOptional()
  @IsEnum(QuoteSource)
  source?: QuoteSource;

  @IsOptional()
  @IsString()
  batchId?: string;
}

export class QuoteRequestDto {
  @IsOptional()
  @IsString()
  userId?: string;

  /** BFF sends `units`; legacy internal callers may use `count` */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  units?: number;

  /** Legacy field – kept for backward compat with internal callers */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  count?: number;

  @IsOptional()
  @IsEnum(CreditType)
  creditType?: CreditType;

  /** BFF /internal/billing/quote sends revision at root level */
  @IsOptional()
  @IsString()
  revision?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuoteContextDto)
  context?: QuoteContextDto;
}

// ── Response types aligned with BFF openapi.yaml ──────────────────────────────

export class SourceBreakdownDto {
  units: number;
  remaining?: number;
  amount?: number;
}

export class QuoteBreakdownDto {
  subscription: SourceBreakdownDto;
  credits: SourceBreakdownDto;
  wallet: SourceBreakdownDto;
}

export class ShortfallDto {
  units: number;
  amountRequired: number;
}

export class QuoteResponseDto {
  canProcess: boolean;
  partial: boolean;
  requested: number;
  allowedTotal: number;
  unitPrice: number;
  bySource: QuoteBreakdownDto;
  shortfall?: ShortfallDto;
}

// ── Legacy internal types (kept for SagaService.block() internals) ─────────────
