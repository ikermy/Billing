import { Test, TestingModule } from '@nestjs/testing';
import { BillingService } from './billing.service';
import { BillingV1Controller } from './billing-v1.controller';

describe('BillingV1Controller', () => {
  let controller: BillingV1Controller;
  let service: jest.Mocked<BillingService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingV1Controller],
      providers: [
        {
          provide: BillingService,
          useValue: {
            getBalance: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(BillingV1Controller);
    service = module.get(BillingService);
  });

  it('returns balance through v1 alias route', async () => {
    (service.getBalance as any).mockResolvedValue({
      subscription: false,
      credits: { barcode: 10, ai: 2 },
      wallet: { available: 15, currency: 'USD' },
    });

    await expect(controller.getBalance('u1')).resolves.toEqual({
      subscription: false,
      credits: { barcode: 10, ai: 2 },
      wallet: { available: 15, currency: 'USD' },
    });
    expect(service.getBalance).toHaveBeenCalledWith('u1');
  });
});
