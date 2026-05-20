import {
  BillingConfigService,
  VolumeDiscountTier,
} from './billing-config.service';
import { PricingService } from './pricing.service';

describe('PricingService', () => {
  let service: PricingService;

  const billingConfig = {
    getNumber: jest.fn(),
    getVolumeDiscounts: jest.fn(),
  } as unknown as jest.Mocked<BillingConfigService>;

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.ENABLE_DYNAMIC_PRICING;
    (billingConfig.getNumber as any).mockResolvedValue(0.5);
    (billingConfig.getVolumeDiscounts as any).mockResolvedValue([]);
    service = new PricingService(billingConfig);
  });

  it('uses default price when dynamic pricing is disabled', async () => {
    const pricing = await service.getPricing('barcode_pdf417', 10);

    expect(billingConfig.getNumber).toHaveBeenCalledTimes(1);
    expect(billingConfig.getNumber).toHaveBeenCalledWith(
      'unit_price.default',
      0.5,
    );
    expect(pricing.unitPrice).toBe(0.5);
    expect(pricing.baseUnitPrice).toBe(0.5);
    expect(pricing.discountPercent).toBe(0);
    expect(pricing.volumeDiscount).toBeNull();
  });

  it('applies matching volume discount tier', async () => {
    process.env.ENABLE_DYNAMIC_PRICING = 'true';
    const discounts: VolumeDiscountTier[] = [
      {
        id: 'vd-1',
        minUnits: 100,
        maxUnits: 499,
        discountPercent: 5,
        isActive: true,
      },
    ];
    (billingConfig.getNumber as any)
      .mockResolvedValueOnce(0.5)
      .mockResolvedValueOnce(0.5);
    (billingConfig.getVolumeDiscounts as any).mockResolvedValue(discounts);
    service = new PricingService(billingConfig as any);

    const pricing = await service.getPricing('barcode_pdf417', 120);

    expect(pricing.discountPercent).toBe(5);
    expect(pricing.unitPrice).toBe(0.48);
    expect(pricing.volumeDiscount).toEqual(discounts[0]);
  });

  it('prefers product+revision override when dynamic pricing is enabled', async () => {
    process.env.ENABLE_DYNAMIC_PRICING = 'true';
    (billingConfig.getNumber as any)
      .mockResolvedValueOnce(0.5)
      .mockResolvedValueOnce(0.6)
      .mockResolvedValueOnce(0.7)
      .mockResolvedValueOnce(0.8);
    (billingConfig.getVolumeDiscounts as any).mockResolvedValue([]);
    service = new PricingService(billingConfig as any);

    const pricing = await service.getPricing(
      'barcode_pdf417',
      10,
      'US.CA 08292017',
    );

    expect(billingConfig.getNumber).toHaveBeenNthCalledWith(
      1,
      'unit_price.default',
      0.5,
    );
    expect(billingConfig.getNumber).toHaveBeenNthCalledWith(
      2,
      'unit_price.by_product.barcode_pdf417',
      0.5,
    );
    expect(billingConfig.getNumber).toHaveBeenNthCalledWith(
      3,
      'unit_price.by_revision.US_CA_08292017',
      0.6,
    );
    expect(billingConfig.getNumber).toHaveBeenNthCalledWith(
      4,
      'unit_price.by_product_revision.barcode_pdf417.US_CA_08292017',
      0.7,
    );
    expect(pricing.baseUnitPrice).toBe(0.8);
    expect(pricing.unitPrice).toBe(0.8);
  });
});
