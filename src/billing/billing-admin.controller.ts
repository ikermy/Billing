import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from 'src/shared/decorator/user.decorator';
import { AdminGuard } from 'src/shared/guards/admin.guard';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';
import { UpdateBillingConfigDto } from './dto/update-billing-config.dto';
import {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/manage-subscription-plan.dto';
import {
  CreateVolumeDiscountDto,
  UpdateVolumeDiscountDto,
} from './dto/manage-volume-discount.dto';

@Controller('admin/billing')
@UseGuards(AuthGuard('jwt'), AdminGuard)
export class BillingAdminController {
  constructor(
    private readonly billingConfig: BillingConfigService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Get('config')
  async listConfig() {
    return await this.billingConfig.listEffectiveConfig();
  }

  @Put('config/:key')
  async updateConfig(
    @Param('key') key: string,
    @Body() dto: UpdateBillingConfigDto,
    @User('id') userId: string,
  ) {
    const config = await this.billingConfig.setValue(key, dto.value, userId);

    return {
      key: config.key,
      value: config.value,
      updatedBy: config.updatedBy,
      updatedAt: config.updatedAt,
    };
  }

  @Get('subscription-plans')
  async listSubscriptionPlans() {
    return {
      plans: await this.subscriptions.listPlans(),
    };
  }

  @Post('subscription-plans')
  async createSubscriptionPlan(@Body() dto: CreateSubscriptionPlanDto) {
    return await this.subscriptions.createPlanFromLago({
      lagoPlanCode: dto.lagoPlanCode,
      monthlyCredits: dto.monthlyCredits,
      isActive: dto.isActive,
      features: dto.features,
    });
  }

  @Patch('subscription-plans/:id')
  async updateSubscriptionPlan(
    @Param('id') id: string,
    @Body() dto: UpdateSubscriptionPlanDto,
  ) {
    return await this.subscriptions.updatePlan(id, {
      monthlyCredits: dto.monthlyCredits,
      isActive: dto.isActive,
      features: dto.features,
    });
  }

  @Delete('subscription-plans/:id')
  async deactivateSubscriptionPlan(@Param('id') id: string) {
    return await this.subscriptions.deactivatePlan(id);
  }

  @Get('volume-discounts')
  async listVolumeDiscounts() {
    return {
      discounts: await this.billingConfig.listVolumeDiscounts(),
    };
  }

  @Post('volume-discounts')
  async createVolumeDiscount(
    @Body() dto: CreateVolumeDiscountDto,
    @User('id') userId: string,
  ) {
    return await this.billingConfig.createVolumeDiscount(
      {
        minUnits: dto.minUnits,
        maxUnits: dto.maxUnits ?? null,
        discountPercent: dto.discountPercent,
        isActive: dto.isActive,
      },
      userId,
    );
  }

  @Patch('volume-discounts/:id')
  async updateVolumeDiscount(
    @Param('id') id: string,
    @Body() dto: UpdateVolumeDiscountDto,
    @User('id') userId: string,
  ) {
    return await this.billingConfig.updateVolumeDiscount(
      id,
      {
        minUnits: dto.minUnits,
        maxUnits: dto.maxUnits,
        discountPercent: dto.discountPercent,
        isActive: dto.isActive,
      },
      userId,
    );
  }

  @Delete('volume-discounts/:id')
  async deactivateVolumeDiscount(
    @Param('id') id: string,
    @User('id') userId: string,
  ) {
    return await this.billingConfig.deactivateVolumeDiscount(id, userId);
  }
}
