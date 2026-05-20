import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PackageDto } from './package.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Premium Pack +' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'Even better value' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    type: [PackageDto],
    example: [{ credits: 500, price: 39.99 }],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PackageDto)
  @ArrayMinSize(1)
  @IsOptional()
  packages?: PackageDto[];
}
