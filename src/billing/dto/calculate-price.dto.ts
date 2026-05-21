import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CalculatePriceDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  packageIndex?: number;

  @IsString()
  @IsOptional()
  couponCode: string;

  @IsString()
  @IsOptional()
  planCode: string;

  @IsString()
  @IsNotEmpty()
  userId: string;
}
