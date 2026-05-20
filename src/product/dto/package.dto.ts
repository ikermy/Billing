import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min, IsNumber } from 'class-validator';

export class PackageDto {
  @ApiProperty({ example: 100, description: 'Credit amount (>= 0, integer)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  credits: number;

  @ApiProperty({ example: 9.99, description: 'Price in currency units (>= 0)' })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'price must be a number' },
  )
  @Min(0)
  price: number;
}
