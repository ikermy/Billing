import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export enum BuyType {
  SINGLE,
  PACKAGE,
  SUBSCRIPTION,
}

export class BuyBarcodesDto {
  @IsEnum(BuyType)
  type: BuyType;

  @ValidateIf((dto: BuyBarcodesDto) => dto.type === BuyType.SUBSCRIPTION)
  @Type(() => String)
  @IsString()
  @IsNotEmpty()
  code?: string;

  @ValidateIf((dto: BuyBarcodesDto) => dto.type === BuyType.PACKAGE)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  index?: number;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsNotEmpty()
  referrerId?: string;

  userId!: string;
}
