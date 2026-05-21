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
import { QuoteBreakdownDto } from './quote.dto';

export class BlockContextDto {
  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsString()
  revision?: string;
}

export class BlockRequestDto {
  @IsString()
  userId: string;

  /** BFF sends `units`; can be 0 for free barcode edit */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  units: number;

  /**
   * BFF-generated saga ID in format "saga-{userId}-{buildId}-{batchId}".
   * NOT a UUID — must use @IsString(), never @IsUUID().
   */
  @IsOptional()
  @IsString()
  sagaId?: string;

  /** BFF sends the quote breakdown so Billing can skip re-quoting */
  @IsOptional()
  @ValidateNested()
  @Type(() => QuoteBreakdownDto)
  bySource?: QuoteBreakdownDto;

  @IsOptional()
  @IsEnum(CreditType)
  creditType?: CreditType;

  @IsOptional()
  @IsString()
  operation?: string;

  @IsOptional()
  @IsString()
  buildId?: string;

  @IsOptional()
  @IsString()
  batchId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  ttl?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => BlockContextDto)
  context?: BlockContextDto;
}

/** Response-only DTO — validation decorators not required */
export class SagaBlockedDto {
  subscription: number;
  credits: number;
  wallet: number;
}

/** Response-only DTO — validation decorators not required */
export class BlockResponseDto {
  sagaId: string;
  blocked: SagaBlockedDto;
  expiresAt: string;
}
