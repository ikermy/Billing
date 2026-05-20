import { Test, TestingModule } from '@nestjs/testing';
import { BillingAdminController } from './billing-admin.controller';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';

describe('BillingAdminController', () => {
  let controller: BillingAdminController;
  let billingConfig: jest.Mocked<BillingConfigService>;
  let subscriptions: jest.Mocked<SubscriptionService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingAdminController],
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

    controller = module.get(BillingAdminController);
    billingConfig = module.get(BillingConfigService);
    subscriptions = module.get(SubscriptionService);
  });

  it('returns effective config list', async () => {
    (billingConfig.listEffectiveConfig as any).mockResolvedValue({
      'unit_price.default': 0.5,
    });

    await expect(controller.listConfig()).resolves.toEqual({
      'unit_price.default': 0.5,
    });
  });

  it('updates config value with actor id', async () => {
    const updatedAt = new Date('2026-03-14T20:00:00.000Z');
    (billingConfig.setValue as any).mockResolvedValue({
      key: 'volume_discounts',
      value: [{ minUnits: 100, discountPercent: 5 }],
      updatedBy: 'admin-1',
      updatedAt,
    });

    const result = await controller.updateConfig(
      'volume_discounts',
      {
        value: [{ minUnits: 100, discountPercent: 5 }],
      },
      'admin-1',
    );

    expect(billingConfig.setValue).toHaveBeenCalledWith(
      'volume_discounts',
      [{ minUnits: 100, discountPercent: 5 }],
      'admin-1',
    );
    expect(result).toEqual({
      key: 'volume_discounts',
      value: [{ minUnits: 100, discountPercent: 5 }],
      updatedBy: 'admin-1',
      updatedAt,
    });
  });

  it('lists subscription plans', async () => {
    (subscriptions.listPlans as any).mockResolvedValue([
      { id: 'plan-1', lagoPlanCode: 'pro' },
    ]);

    await expect(controller.listSubscriptionPlans()).resolves.toEqual({
      plans: [{ id: 'plan-1', lagoPlanCode: 'pro' }],
    });
  });

  it('creates subscription plan from lago snapshot', async () => {
    (subscriptions.createPlanFromLago as any).mockResolvedValue({
      id: 'plan-1',
      lagoPlanCode: 'pro',
      monthlyCredits: 200,
    });

    const result = await controller.createSubscriptionPlan({
      lagoPlanCode: 'pro',
      monthlyCredits: 200,
    });

    expect(subscriptions.createPlanFromLago).toHaveBeenCalledWith({
      lagoPlanCode: 'pro',
      monthlyCredits: 200,
      isActive: undefined,
      features: undefined,
    });
    expect(result).toEqual({
      id: 'plan-1',
      lagoPlanCode: 'pro',
      monthlyCredits: 200,
    });
  });

  it('passes arbitrary json features without unsafe casts', async () => {
    (subscriptions.updatePlan as any).mockResolvedValue({
      id: 'plan-1',
      features: { seats: 10 },
    });

    const result = await controller.updateSubscriptionPlan('plan-1', {
      features: { seats: 10 },
    });

    expect(subscriptions.updatePlan).toHaveBeenCalledWith('plan-1', {
      monthlyCredits: undefined,
      isActive: undefined,
      features: { seats: 10 },
    });
    expect(result).toEqual({
      id: 'plan-1',
      features: { seats: 10 },
    });
  });

  it('lists volume discounts', async () => {
    (billingConfig.listVolumeDiscounts as any).mockResolvedValue([
      { id: 'vd-1', minUnits: 100, discountPercent: 5, isActive: true },
    ]);

    await expect(controller.listVolumeDiscounts()).resolves.toEqual({
      discounts: [
        { id: 'vd-1', minUnits: 100, discountPercent: 5, isActive: true },
      ],
    });
  });

  it('creates volume discount with actor id', async () => {
    (billingConfig.createVolumeDiscount as any).mockResolvedValue({
      id: 'vd-1',
      minUnits: 100,
      maxUnits: 499,
      discountPercent: 5,
      isActive: true,
    });

    await expect(
      controller.createVolumeDiscount(
        {
          minUnits: 100,
          maxUnits: 499,
          discountPercent: 5,
        },
        'admin-1',
      ),
    ).resolves.toEqual({
      id: 'vd-1',
      minUnits: 100,
      maxUnits: 499,
      discountPercent: 5,
      isActive: true,
    });

    expect(billingConfig.createVolumeDiscount).toHaveBeenCalledWith(
      {
        minUnits: 100,
        maxUnits: 499,
        discountPercent: 5,
        isActive: undefined,
      },
      'admin-1',
    );
  });
});
