import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class WaivedCheckRequestDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  operation: string;
}

export class WaivedReleaseRequestDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  operation: string;
}

export class WaivedCompleteRequestDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  operation: string;

  @IsOptional()
  @IsString()
  generationId?: string;
}

/** Response-only DTO — validation decorators not required */
export class WaivedCheckResponseDto {
  allowed: boolean;
  currentCount: number;
  limit: number;
  resetsAt: string;
}
