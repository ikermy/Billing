import { Prisma, SubscriptionStatus } from '@prisma/client';
import { SubscriptionService } from './subscription.service';
import { PrismaService } from './prisma.service';
import { LagoService } from './lago.service';
import { RedisService } from './redis.service';

describe('SubscriptionService', () => {
  let service: SubscriptionService;

  const prisma = {
    subscriptionPlan: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    subscription: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $executeRaw: jest.fn(),
  } as unknown as jest.Mocked<PrismaService>;

  const lago = {
    checkPlan: jest.fn(),
    getCustomerSubscriptions: jest.fn(),
  } as unknown as jest.Mocked<LagoService>;

  const redis = {
    getJson: jest.fn(),
    set: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  const localPlan = {
    id: 'plan-local-1',
    name: 'Pro',
    lagoPlanCode: 'pro',
    monthlyCredits: 200,
    priceMonthly: new Prisma.Decimal(29.99),
    currency: 'USD',
    isActive: true,
    features: null,
  };

  const remoteSubscription = {
    lago_id: 'lago-sub-1',
    external_id: 'pro-acc-1',
    lago_customer_id: 'lago-customer-1',
    external_customer_id: 'acc-1',
    billing_time: 'calendar',
    plan_code: 'pro',
    status: 'active',
    created_at: '2026-03-01T00:00:00.000Z',
    subscription_at: '2026-03-01T00:00:00.000Z',
    started_at: '2026-03-01T00:00:00.000Z',
    ending_at: null,
    current_billing_period_started_at: '2026-03-01T00:00:00.000Z',
    current_billing_period_ending_at: '2027-04-01T00:00:00.000Z',
    on_termination_credit_note: 'credit',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (redis.getJson as any).mockResolvedValue(null);
    (redis.set as any).mockResolvedValue(undefined);
    service = new SubscriptionService(prisma, lago, redis);
  });

  it('creates local subscription plan from lago snapshot', async () => {
    (lago.checkPlan as any).mockResolvedValue({
      plan: {
        name: 'Pro',
        amountCents: 2999,
        amountCurrency: 'USD',
      },
    });
    (prisma.subscriptionPlan.upsert as any).mockResolvedValue(localPlan);

    const result = await service.createPlanFromLago({
      lagoPlanCode: 'pro',
      monthlyCredits: 200,
    });

    expect(lago.checkPlan).toHaveBeenCalledWith('pro');
    expect(prisma.subscriptionPlan.upsert).toHaveBeenCalled();
    expect(result).toEqual(localPlan);
  });

  it('returns false summary when account has no subscriptions', async () => {
    (lago.getCustomerSubscriptions as any).mockResolvedValue([]);
    (prisma.subscription.updateMany as any).mockResolvedValue({ count: 0 });
    (prisma.subscription.findFirst as any).mockResolvedValue(null);

    await expect(service.getSummary('acc-1')).resolves.toBe(false);
  });

  it('reserves included generations from active subscription period', async () => {
    const createdSubscription = {
      id: 'sub-local-1',
      accountId: 'acc-1',
      planId: 'plan-local-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-04-01T00:00:00.000Z'),
      creditsAllocated: 200,
      creditsUsed: 0,
      lagoSubscriptionId: 'lago-sub-1',
      lagoExternalId: 'pro-acc-1',
      plan: localPlan,
    };
    const updatedSubscription = {
      ...createdSubscription,
      creditsUsed: 3,
    };

    (lago.getCustomerSubscriptions as any).mockResolvedValue([
      remoteSubscription,
    ]);
    (lago.checkPlan as any).mockResolvedValue({
      plan: {
        name: 'Pro',
        amountCents: 2999,
        amountCurrency: 'USD',
      },
    });
    (prisma.subscriptionPlan.findUnique as any).mockResolvedValue(localPlan);
    (prisma.subscriptionPlan.upsert as any).mockResolvedValue(localPlan);
    (prisma.subscription.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdSubscription);
    (prisma.subscription.create as any).mockResolvedValue(createdSubscription);
    (prisma.subscription.updateMany as any).mockResolvedValue({ count: 0 });
    (prisma.$executeRaw as any).mockResolvedValue(1);
    (prisma.subscription.findUnique as any).mockResolvedValue(
      updatedSubscription,
    );

    const result = await service.reserveGenerations('acc-1', 3);

    expect(lago.getCustomerSubscriptions).toHaveBeenCalledWith('acc-1', [
      'active',
      'pending',
      'terminated',
      'canceled',
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(result).toEqual(updatedSubscription);
  });

  it('reuses fresh subscription projection without hitting lago again', async () => {
    const localSubscription = {
      id: 'sub-local-1',
      accountId: 'acc-1',
      planId: 'plan-local-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2027-04-01T00:00:00.000Z'),
      creditsAllocated: 200,
      creditsUsed: 10,
      lagoSubscriptionId: 'lago-sub-1',
      lagoExternalId: 'pro-acc-1',
      plan: localPlan,
    };

    (lago.getCustomerSubscriptions as any).mockResolvedValue([
      remoteSubscription,
    ]);
    (lago.checkPlan as any).mockResolvedValue({
      plan: {
        name: 'Pro',
        amountCents: 2999,
        amountCurrency: 'USD',
      },
    });
    (prisma.subscriptionPlan.findUnique as any).mockResolvedValue(localPlan);
    (prisma.subscriptionPlan.upsert as any).mockResolvedValue(localPlan);
    (prisma.subscription.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(localSubscription)
      .mockResolvedValueOnce(localSubscription);
    (prisma.subscription.create as any).mockResolvedValue(localSubscription);
    (prisma.subscription.updateMany as any).mockResolvedValue({ count: 0 });
    (redis.getJson as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(true);

    await expect(service.getSummary('acc-1')).resolves.toEqual({
      active: true,
      status: SubscriptionStatus.ACTIVE,
      plan: 'Pro',
      planCode: 'pro',
      allocated: 200,
      used: 10,
      remaining: 190,
      startsAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2027-04-01T00:00:00.000Z',
    });
    await expect(service.getSummary('acc-1')).resolves.toEqual({
      active: true,
      status: SubscriptionStatus.ACTIVE,
      plan: 'Pro',
      planCode: 'pro',
      allocated: 200,
      used: 10,
      remaining: 190,
      startsAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2027-04-01T00:00:00.000Z',
    });

    expect(lago.getCustomerSubscriptions).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'billing:subscription:sync:acc-1',
      true,
      300,
    );
  });

  it('syncs subscription projection again after sync marker expires', async () => {
    const localSubscription = {
      id: 'sub-local-1',
      accountId: 'acc-1',
      planId: 'plan-local-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2027-04-01T00:00:00.000Z'),
      creditsAllocated: 200,
      creditsUsed: 10,
      lagoSubscriptionId: 'lago-sub-1',
      lagoExternalId: 'pro-acc-1',
      plan: localPlan,
    };

    (lago.getCustomerSubscriptions as any).mockResolvedValue([
      remoteSubscription,
    ]);
    (lago.checkPlan as any).mockResolvedValue({
      plan: {
        name: 'Pro',
        amountCents: 2999,
        amountCurrency: 'USD',
      },
    });
    (prisma.subscriptionPlan.findUnique as any).mockResolvedValue(localPlan);
    (prisma.subscriptionPlan.upsert as any).mockResolvedValue(localPlan);
    (prisma.subscription.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(localSubscription)
      .mockResolvedValueOnce(localSubscription)
      .mockResolvedValueOnce(localSubscription);
    (prisma.subscription.create as any).mockResolvedValue(localSubscription);
    (prisma.subscription.update as any).mockResolvedValue(localSubscription);
    (prisma.subscription.updateMany as any).mockResolvedValue({ count: 0 });
    (redis.getJson as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await service.getSummary('acc-1');
    await service.getSummary('acc-1');

    expect(lago.getCustomerSubscriptions).toHaveBeenCalledTimes(2);
  });
});
