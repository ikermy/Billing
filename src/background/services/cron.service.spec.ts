import { CronService } from './cron.service';

describe('CronService', () => {
  let service: CronService;

  const prisma = {
    product: {
      findMany: jest.fn(),
    },
  };

  const lago = {
    getPlans: jest.fn(),
    getCoupons: jest.fn(),
  };

  const producer = {
    subscriptionTerminated: jest.fn(),
    couponTerminated: jest.fn(),
  };

  const redis = {
    set: jest.fn(),
  };

  const saga = {
    expirePendingSagas: jest.fn(),
  };

  const subscriptions = {
    expireEndedSubscriptions: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (redis.set as any).mockResolvedValue(undefined);
    service = new CronService(
      prisma as any,
      lago as any,
      producer as any,
      redis as any,
      saga as any,
      subscriptions as any,
    );
  });

  it('writes product cache entries with a 15 minute ttl', async () => {
    (prisma.product.findMany as any).mockResolvedValue([
      {
        id: 'product-1',
        name: 'barcode_pdf417',
      },
    ]);

    await service.renewProducts();

    expect(redis.set).toHaveBeenCalledWith(
      'product:product-1',
      {
        id: 'product-1',
        name: 'barcode_pdf417',
      },
      900,
    );
  });

  it('writes plan cache entries with a 15 minute ttl', async () => {
    (lago.getPlans as any).mockResolvedValue({
      plans: [
        {
          code: 'pro',
          name: 'Pro',
        },
      ],
    });

    await service.renewPlans();

    expect(redis.set).toHaveBeenCalledWith(
      'lago:plan:pro',
      {
        code: 'pro',
        name: 'Pro',
      },
      900,
    );
  });

  it('writes coupon cache entries with a 15 minute ttl', async () => {
    (lago.getCoupons as any).mockResolvedValue({
      coupons: [
        {
          code: 'coupon-1',
          name: 'Launch',
        },
      ],
    });

    await service.renewCoupons();

    expect(redis.set).toHaveBeenCalledWith(
      'lago:coupon:coupon-1',
      {
        code: 'coupon-1',
        name: 'Launch',
      },
      900,
    );
  });
});
