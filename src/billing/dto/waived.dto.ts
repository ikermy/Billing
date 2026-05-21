import { IsNotEmpty, IsString } from 'class-validator';

export class WaivedCheckRequestDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  operation: string;
}

/** Response-only DTO — validation decorators not required */
export class WaivedCheckResponseDto {
  allowed: boolean;
  currentCount: number;
  limit: number;
  resetsAt: string;
}
