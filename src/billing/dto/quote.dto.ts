import { CreditType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
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

// ── Response / nested types aligned with BFF openapi.yaml ────────────────────

export class SourceBreakdownDto {
  @IsInt()
  @Min(0)
  units: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  remaining?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}

export class QuoteBreakdownDto {
  @ValidateNested()
  @Type(() => SourceBreakdownDto)
  subscription: SourceBreakdownDto;

  @ValidateNested()
  @Type(() => SourceBreakdownDto)
  credits: SourceBreakdownDto;

  @ValidateNested()
  @Type(() => SourceBreakdownDto)
  wallet: SourceBreakdownDto;
}

export class ShortfallDto {
  @IsInt()
  @Min(0)
  units: number;

  @IsNumber()
  @Min(0)
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
