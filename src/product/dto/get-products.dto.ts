import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { PaginationDto } from 'src/shared/dto/pagination.dto';

export class GetProductsDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter by product name (case-insensitive, substring match)',
    example: 'prem',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;
}
