import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from 'src/shared/decorator/user.decorator';
import { BillingService } from './billing.service';

@Controller('v1/me')
@UseGuards(AuthGuard('jwt'))
export class BillingV1Controller {
  private readonly logger = new Logger(BillingV1Controller.name);

  constructor(private readonly billingService: BillingService) {}

  @Get('balance')
  async getBalance(@User('id') userId: string) {
    try {
      const result = await this.billingService.getBalance(userId);
      this.logger.log(`v1 getBalance success for userId=${userId}`);
      return result;
    } catch (error) {
      this.logger.error(`v1 getBalance failed for userId=${userId}`, error);
      throw error;
    }
  }
}
