import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PackageDto } from './package.dto';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'Premium Pack' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Best value pack' })
  @IsString()
  description: string;

  @ApiProperty({
    type: [PackageDto],
    example: [
      { credits: 100, price: 9.99 },
      { credits: 250, price: 19.99 },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PackageDto)
  packages: PackageDto[];
}
