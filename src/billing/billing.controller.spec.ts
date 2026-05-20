import { Test, TestingModule } from '@nestjs/testing';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { HttpException } from '@nestjs/common';

describe('BillingController', () => {
  let controller: BillingController;
  let service: jest.Mocked<BillingService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        {
          provide: BillingService,
          useValue: {
            buyBarcodes: jest.fn(),
            calculatePrice: jest.fn(),
            checkCoupon: jest.fn(),
            checkCredits: jest.fn(),
            checkSubscription: jest.fn(),
            getBalance: jest.fn(),
            topUpWallet: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<BillingController>(BillingController);
    service = module.get(BillingService);
  });

  it('defined', () => {
    expect(controller).toBeDefined();
  });

  // ---- buyBarcodes ----
  it('buyBarcodes: returns service result', async () => {
    (service.buyBarcodes as any).mockResolvedValue({ message: 'ok' });

    const res = await controller.buyBarcodes('u1', { index: 0 } as any);
    expect(service.buyBarcodes).toHaveBeenCalledWith({
      index: 0,
      userId: 'u1',
    });
    expect(res).toEqual({ message: 'ok' });
  });

  it('buyBarcodes: bubbles HttpException', async () => {
    (service.buyBarcodes as any).mockRejectedValue(
      new HttpException('bad', 400),
    );

    await expect(
      controller.buyBarcodes('u1', { index: 0 } as any),
    ).rejects.toBeInstanceOf(HttpException);
  });

  // ---- calculatePrice ----
  it('calculatePrice: returns service result', async () => {
    (service.calculatePrice as any).mockResolvedValue({ totalPrice: 42 });

    const res = await controller.calculatePrice(
      { productId: 'p1' } as any,
      'u1',
    );
    expect(service.calculatePrice).toHaveBeenCalledWith({
      productId: 'p1',
      userId: 'u1',
    });
    expect(res).toEqual({ totalPrice: 42 });
  });

  it('calculatePrice: bubbles HttpException', async () => {
    (service.calculatePrice as any).mockRejectedValue(
      new HttpException('bad', 500),
    );

    await expect(
      controller.calculatePrice({ productId: 'p1' } as any, 'u1'),
    ).rejects.toBeInstanceOf(HttpException);
  });

  // ---- checkCoupon ----
  it('checkCoupon: returns service result', async () => {
    (service.checkCoupon as any).mockResolvedValue({
      coupon: { code: 'SAVE10' },
    });

    const res = await controller.checkCoupon('SAVE10');
    expect(service.checkCoupon).toHaveBeenCalledWith('SAVE10');
    expect(res).toEqual({ coupon: { code: 'SAVE10' } });
  });

  // ---- checkCredits ----
  it('checkCredits: returns service result', async () => {
    (service.checkCredits as any).mockResolvedValue({ balance: 100 });

    const res = await controller.checkAccount('u1');
    expect(service.checkCredits).toHaveBeenCalledWith('u1');
    expect(res).toEqual({ balance: 100 });
  });

  it('checkCredits: bubbles HttpException', async () => {
    (service.checkCredits as any).mockRejectedValue(
      new HttpException('not found', 404),
    );

    await expect(controller.checkAccount('uX')).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('getBalance: returns service result', async () => {
    (service.getBalance as any).mockResolvedValue({
      subscription: false,
      credits: { barcode: 10, ai: 3 },
      wallet: { available: 15, currency: 'USD' },
    });

    const res = await controller.getBalance('u1');

    expect(service.getBalance).toHaveBeenCalledWith('u1');
    expect(res).toEqual({
      subscription: false,
      credits: { barcode: 10, ai: 3 },
      wallet: { available: 15, currency: 'USD' },
    });
  });

  it('topUpWallet: returns service result', async () => {
    (service.topUpWallet as any).mockResolvedValue({
      balance: 115,
      creditedAmount: 115,
      bonusAmount: 15,
      currency: 'USD',
      bonusPercent: 15,
    });

    const res = await controller.topUpWallet('u1', {
      amount: 100,
    });

    expect(service.topUpWallet).toHaveBeenCalledWith('u1', {
      amount: 100,
    });
    expect(res.bonusPercent).toBe(15);
  });
});
