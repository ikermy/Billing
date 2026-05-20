import { NotFoundException } from '@nestjs/common';
import { BillingConfigService } from './billing-config.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

describe('BillingConfigService', () => {
  let service: BillingConfigService;

  const prisma = {
    billingConfig: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;

  const redis = {
    getJson: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  beforeEach(() => {
    jest.clearAllMocks();
    (redis.getJson as any).mockResolvedValue(null);
    (redis.set as any).mockResolvedValue(undefined);
    (redis.del as any).mockResolvedValue(0);
    service = new BillingConfigService(prisma, redis);
  });

  it('returns only active volume discounts for pricing', async () => {
    (prisma.billingConfig.findUnique as any).mockResolvedValue({
      value: [
        {
          id: 'vd-1',
          minUnits: 100,
          maxUnits: 499,
          discountPercent: 5,
          isActive: true,
        },
        {
          id: 'vd-2',
          minUnits: 500,
          maxUnits: null,
          discountPercent: 10,
          isActive: false,
        },
      ],
    });

    await expect(service.getVolumeDiscounts()).resolves.toEqual([
      {
        id: 'vd-1',
        minUnits: 100,
        maxUnits: 499,
        discountPercent: 5,
        isActive: true,
      },
    ]);
  });

  it('creates and persists a new volume discount', async () => {
    (prisma.billingConfig.findUnique as any).mockResolvedValue({
      value: [],
    });
    (prisma.billingConfig.upsert as any).mockResolvedValue({
      key: 'volume_discounts',
    });

    const result = await service.createVolumeDiscount(
      {
        minUnits: 100,
        maxUnits: 499,
        discountPercent: 5,
      },
      'admin-1',
    );

    expect(result.id).toBeTruthy();
    expect(result.isActive).toBe(true);
    expect(prisma.billingConfig.upsert).toHaveBeenCalled();
  });

  it('updates an existing volume discount by id', async () => {
    (prisma.billingConfig.findUnique as any).mockResolvedValue({
      value: [
        {
          id: 'vd-1',
          minUnits: 100,
          maxUnits: 499,
          discountPercent: 5,
          isActive: true,
        },
      ],
    });
    (prisma.billingConfig.upsert as any).mockResolvedValue({
      key: 'volume_discounts',
    });

    await expect(
      service.updateVolumeDiscount(
        'vd-1',
        {
          discountPercent: 7,
        },
        'admin-1',
      ),
    ).resolves.toEqual({
      id: 'vd-1',
      minUnits: 100,
      maxUnits: 499,
      discountPercent: 7,
      isActive: true,
    });
  });

  it('throws when updating an unknown volume discount', async () => {
    (prisma.billingConfig.findUnique as any).mockResolvedValue({
      value: [],
    });

    await expect(
      service.updateVolumeDiscount(
        'missing',
        { discountPercent: 5 },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns cached config values without querying prisma', async () => {
    (redis.getJson as any).mockResolvedValue({
      exists: true,
      value: 0.75,
    });

    await expect(service.getNumber('unit_price.default', 0.5)).resolves.toBe(
      0.75,
    );

    expect(prisma.billingConfig.findUnique).not.toHaveBeenCalled();
  });

  it('caches config values after the first prisma read', async () => {
    (prisma.billingConfig.findUnique as any).mockResolvedValue({
      key: 'unit_price.default',
      value: 0.75,
    });
    (redis.getJson as any).mockResolvedValueOnce(null).mockResolvedValueOnce({
      exists: true,
      value: 0.75,
    });

    await expect(service.getNumber('unit_price.default', 0.5)).resolves.toBe(
      0.75,
    );
    await expect(service.getNumber('unit_price.default', 0.5)).resolves.toBe(
      0.75,
    );

    expect(prisma.billingConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'billing:config:key:unit_price.default',
      {
        exists: true,
        value: 0.75,
      },
      60,
    );
  });

  it('invalidates config caches after setValue', async () => {
    (prisma.billingConfig.upsert as any).mockResolvedValue({
      key: 'unit_price.default',
      value: 0.75,
    });

    await service.setValue('unit_price.default', 0.75, 'admin-1');

    expect(redis.del).toHaveBeenCalledWith(
      'billing:config:key:unit_price.default',
      'billing:config:effective',
    );
  });
});
