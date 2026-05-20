import { Test, TestingModule } from '@nestjs/testing';
import { BillingAdminV1Controller } from './billing-admin-v1.controller';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';

describe('BillingAdminV1Controller', () => {
  let controller: BillingAdminV1Controller;
  let billingConfig: jest.Mocked<BillingConfigService>;
  let subscriptions: jest.Mocked<SubscriptionService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingAdminV1Controller],
      providers: [
        {
          provide: BillingConfigService,
          useValue: {
            listEffectiveConfig: jest.fn(),
            setValue: jest.fn(),
            listVolumeDiscounts: jest.fn(),
            createVolumeDiscount: jest.fn(),
            updateVolumeDiscount: jest.fn(),
            deactivateVolumeDiscount: jest.fn(),
          },
        },
        {
          provide: SubscriptionService,
          useValue: {
            listPlans: jest.fn(),
            createPlanFromLago: jest.fn(),
            updatePlan: jest.fn(),
            deactivatePlan: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(BillingAdminV1Controller);
    billingConfig = module.get(BillingConfigService);
    subscriptions = module.get(SubscriptionService);
  });

  it('lists config via v1 admin alias', async () => {
    (billingConfig.listEffectiveConfig as any).mockResolvedValue({
      'unit_price.default': 0.5,
    });

    await expect(controller.listConfig()).resolves.toEqual({
      'unit_price.default': 0.5,
    });
  });

  it('lists volume discounts via v1 admin alias', async () => {
    (billingConfig.listVolumeDiscounts as any).mockResolvedValue([
      { id: 'vd-1', minUnits: 100, discountPercent: 5, isActive: true },
    ]);

    await expect(controller.listVolumeDiscounts()).resolves.toEqual({
      discounts: [
        { id: 'vd-1', minUnits: 100, discountPercent: 5, isActive: true },
      ],
    });
  });

  it('uses put-style subscription update in v1 admin alias', async () => {
    (subscriptions.updatePlan as any).mockResolvedValue({
      id: 'plan-1',
      monthlyCredits: 300,
    });

    await expect(
      controller.updateSubscriptionPlan('plan-1', {
        monthlyCredits: 300,
      }),
    ).resolves.toEqual({
      id: 'plan-1',
      monthlyCredits: 300,
    });

    expect(subscriptions.updatePlan).toHaveBeenCalledWith('plan-1', {
      monthlyCredits: 300,
      isActive: undefined,
      features: undefined,
    });
  });
});
