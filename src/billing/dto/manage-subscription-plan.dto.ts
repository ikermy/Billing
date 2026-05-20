import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateSubscriptionPlanDto {
  @IsString()
  @IsNotEmpty()
  lagoPlanCode: string;

  @IsInt()
  @Min(1)
  monthlyCredits: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  features?: unknown;
}

export class UpdateSubscriptionPlanDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyCredits?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  features?: unknown;
}
