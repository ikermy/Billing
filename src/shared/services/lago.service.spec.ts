import { HttpException } from '@nestjs/common';
import { LagoService } from './lago.service';

let mockClient: any;
let mockGetLagoError: jest.Mock;

// noinspection JSUnusedGlobalSymbols
jest.mock('lago-javascript-client', () => ({
  Client: jest.fn(() => mockClient),
  getLagoError: (...args: unknown[]) => mockGetLagoError(...args),
}));

describe('LagoService', () => {
  let service: LagoService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LAGO_URL = 'https://lago.test';
    process.env.LAGO_API_KEY = 'test-key';

    mockClient = {
      plans: {
        findPlan: jest.fn(),
        findAllPlans: jest.fn(),
      },
      coupons: {
        findCoupon: jest.fn(),
        findAllCoupons: jest.fn(),
      },
      subscriptions: {
        createSubscription: jest.fn(),
        destroySubscription: jest.fn(),
        findAllSubscriptions: jest.fn(),
      },
    };
    mockGetLagoError = jest.fn((error?: { lagoError?: unknown }) => {
      return error?.lagoError ?? null;
    });

    service = new LagoService();
    service.onModuleInit();
  });

  it('maps plan lookup not-found errors to 404', async () => {
    mockClient.plans.findPlan.mockRejectedValue({
      response: { status: 404 },
      lagoError: {
        status: 404,
        error: 'Not Found',
      },
      message: 'Not Found',
    });

    await expectHttpError(
      service.checkPlan('missing-plan'),
      404,
      'Plan not found',
    );
  });

  it('maps customer subscription rate limiting to 429', async () => {
    mockClient.subscriptions.findAllSubscriptions.mockRejectedValue({
      response: { status: 429 },
      lagoError: {
        status: 429,
        error: 'Too Many Requests',
      },
      message: 'Too Many Requests',
    });

    await expectHttpError(
      service.getCustomerSubscriptions('acc-1'),
      429,
      'Lago rate limit exceeded',
    );
  });

  it('maps network failures to 503 for plans list', async () => {
    mockClient.plans.findAllPlans.mockRejectedValue({
      code: 'ECONNABORTED',
      message: 'timeout of 3000ms exceeded',
    });

    await expectHttpError(service.getPlans(), 503, 'Lago plans unavailable');
  });

  it('maps subscription cancellation not-found errors to 404', async () => {
    mockClient.subscriptions.destroySubscription.mockRejectedValue({
      response: { status: 404 },
      lagoError: {
        status: 404,
        error: 'Not Found',
      },
      message: 'Not Found',
    });

    await expectHttpError(
      service.cancelSubscription('missing-subscription'),
      404,
      'Subscription not found',
    );
  });
});

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  message: string,
): Promise<void> {
  expect.assertions(3);

  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).message).toBe(message);
  }
}
