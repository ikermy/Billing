import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class CreateVolumeDiscountDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minUnits: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUnits?: number | null;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  discountPercent: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateVolumeDiscountDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minUnits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUnits?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
