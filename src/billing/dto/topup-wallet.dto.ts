import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, Min } from 'class-validator';

export class TopUpWalletDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
