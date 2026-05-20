import { IsNotEmpty, IsString } from 'class-validator';

export class WaivedCheckRequestDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  operation: string;
}

export class WaivedCheckResponseDto {
  allowed: boolean;
  currentCount: number;
  limit: number;
  resetsAt: string;
}
