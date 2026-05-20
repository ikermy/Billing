import { WalletBalanceService } from './wallet-balance.service';

describe('WalletBalanceService', () => {
  let service: WalletBalanceService;
  let client: {
    get: jest.Mock;
    post: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WALLET_BALANCE_URL = 'https://wallet.test';
    process.env.WALLET_BALANCE_API_KEY = 'wallet-key';

    service = new WalletBalanceService();
    service.onModuleInit();
    client = {
      get: jest.fn(),
      post: jest.fn(),
    };
    (service as any).client = client;
  });

  it('normalizes valid balance payloads', async () => {
    client.get.mockResolvedValue({
      data: {
        available: '12.5',
        blocked: '2',
        currency: 'USD',
      },
    });

    await expect(service.getBalance('user-1')).resolves.toEqual({
      available: 12.5,
      blocked: 2,
      currency: 'USD',
    });
  });

  it('rejects malformed balance payloads', async () => {
    client.get.mockResolvedValue({
      data: {
        available: 'oops',
      },
    });

    await expect(service.getBalance('user-1')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('rejects wallet block responses without blockId', async () => {
    client.post.mockResolvedValue({
      data: {
        amount: 1.5,
        currency: 'USD',
      },
    });

    await expect(
      service.blockFunds({
        userId: 'user-1',
        amount: 1.5,
        currency: 'USD',
      }),
    ).rejects.toMatchObject({
      status: 503,
    });
  });

  it('rejects malformed top up payloads', async () => {
    client.post.mockResolvedValue({
      data: {
        balance: 'oops',
      },
    });

    await expect(
      service.topUpWithBonus({
        userId: 'user-1',
        amount: 10,
      }),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});
