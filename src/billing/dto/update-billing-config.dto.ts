import { IsDefined } from 'class-validator';

export class UpdateBillingConfigDto {
  @IsDefined()
  value: unknown;
}
