import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Account } from '@prisma/client';
import {
  Client,
  CouponObject,
  getLagoError,
  SubscriptionObject,
} from 'lago-javascript-client';
import { CachedCoupon, CachedPlan } from 'src/shared/types/billing.types';
import CircuitBreaker from 'opossum';
import { createCircuitBreaker } from 'src/shared/utils/circuit-breaker.factory';

@Injectable()
export class LagoService implements OnModuleInit {
  private readonly logger = new Logger(LagoService.name);
  private readonly lago: ReturnType<typeof Client>;

  /** Circuit breaker for read-only Lago operations (lookups, subscriptions status) */
  private cbRead!: CircuitBreaker<[() => Promise<unknown>], unknown>;
  /** Circuit breaker for mutating Lago operations (wallet tx, subscription create/cancel) */
  private cbMutate!: CircuitBreaker<[() => Promise<unknown>], unknown>;

  constructor() {
    const LAGO_URL = process.env.LAGO_URL;
    const LAGO_API_KEY = process.env.LAGO_API_KEY;
    if (!LAGO_URL || !LAGO_API_KEY) {
      throw new Error('LAGO_URL or LAGO_API_KEY missing in .env');
    }

    this.lago = Client(LAGO_API_KEY, { baseUrl: LAGO_URL });
  }

  onModuleInit(): void {
    const thunk = async <T>(fn: () => Promise<T>): Promise<T> => await fn();
    const cbDefaults = {
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      timeout: 8_000,
      volumeThreshold: 5,
    };

    this.cbRead = createCircuitBreaker(thunk, {
      name: 'lago.read',
      ...cbDefaults,
    });
    this.cbMutate = createCircuitBreaker(thunk, {
      name: 'lago.mutate',
      ...cbDefaults,
    });
  }

  private async fireRead<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.cbRead.fire(fn);
    return result as T;
  }

  private async fireMutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.cbMutate.fire(fn);
    return result as T;
  }

  private isExpired(coupon: CouponObject): boolean {
    if (coupon.terminated_at) return true;

    if (coupon.expiration === 'time_limit' && coupon.expiration_at) {
      return new Date(coupon.expiration_at).getTime() <= Date.now();
    }
    return false;
  }

  private async throwMappedError(
    error: unknown,
    messages: {
      notFound?: string;
      badRequest: string;
      rateLimited?: string;
      unavailable?: string;
    },
  ): Promise<never> {
    if (error instanceof HttpException) {
      throw error;
    }

    const lagoError = await getLagoError(error);
    const status = this.extractStatus(error, lagoError);
    const errorName = this.extractLagoErrorName(lagoError);
    const fallbackUnavailableMessage =
      messages.unavailable ?? 'Lago service unavailable';
    const fallbackRateLimitedMessage =
      messages.rateLimited ?? 'Lago rate limit exceeded';

    if (status === 404 || errorName === 'Not Found') {
      throw new HttpException(messages.notFound ?? messages.badRequest, 404);
    }

    if (status === 429) {
      throw new HttpException(fallbackRateLimitedMessage, 429);
    }

    if (this.isServiceUnavailable(error, status)) {
      throw new HttpException(fallbackUnavailableMessage, 503);
    }

    throw new HttpException(messages.badRequest, 400);
  }

  private extractStatus(
    error: unknown,
    lagoError?: unknown,
  ): number | undefined {
    if (
      typeof lagoError === 'object' &&
      lagoError !== null &&
      'status' in lagoError &&
      typeof (lagoError as { status?: unknown }).status === 'number'
    ) {
      return (lagoError as { status: number }).status;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof (error as { response?: { status?: unknown } }).response?.status ===
        'number'
    ) {
      return (error as { response: { status: number } }).response.status;
    }

    return undefined;
  }

  private extractLagoErrorName(lagoError: unknown): string | undefined {
    if (
      typeof lagoError === 'object' &&
      lagoError !== null &&
      'error' in lagoError &&
      typeof (lagoError as { error?: unknown }).error === 'string'
    ) {
      return (lagoError as { error: string }).error;
    }

    return undefined;
  }

  private isServiceUnavailable(error: unknown, status?: number): boolean {
    if (typeof status === 'number' && status >= 500) {
      return true;
    }

    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const rawMessage =
      typeof error === 'object' && error !== null && 'message' in error
        ? (error as { message?: unknown }).message
        : '';
    const message = typeof rawMessage === 'string' ? rawMessage : '';
    const normalizedMessage = message.toLowerCase();

    return typeof code === 'string' &&
      [
        'ECONNABORTED',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EHOSTUNREACH',
        'ERR_NETWORK',
      ].includes(code)
      ? true
      : ['timeout', 'timed out', 'network', 'socket hang up', 'aborted'].some(
          (fragment) => normalizedMessage.includes(fragment),
        );
  }

  // noinspection JSUnusedGlobalSymbols
  async addOns(code: string, account: Account) {
    return await this.fireMutate(async () => {
      try {
        const { data } = await this.lago.invoices.createInvoice({
          invoice: {
            external_customer_id: account.id,
            fees: [
              {
                add_on_code: code,
                invoice_display_name: 'Buy one barcode',
              },
            ],
          },
        });
        return data.invoice;
      } catch (error) {
        const lagoError =
          await getLagoError<typeof this.lago.addOns.findAddOn>(error);
        if (lagoError?.error === 'Not Found') {
          throw new HttpException('Add ons not found', 404);
        } else {
          this.logger.error('Error occured in barcode add ons', error);
          throw new HttpException('Bad request', 400);
        }
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async topUpWallet(value: number, account: Account) {
    return await this.fireMutate(async () => {
      try {
        const { data } =
          await this.lago.walletTransactions.createWalletTransaction({
            wallet_transaction: {
              wallet_id: account.walletId,
              granted_credits: `${value}`,
            },
          });
        return data.wallet_transactions;
      } catch (error) {
        this.logger.error('Error occured in top up wallet', error);
        throw new HttpException('Bad request', 400);
      }
    });
  }

  async subscriptionPlan(code: string, account: Account) {
    return await this.fireMutate(async () => {
      try {
        const { data } = await this.lago.subscriptions.createSubscription({
          subscription: {
            external_customer_id: account.id,
            plan_code: code,
            external_id: `${code}-${account.id}`,
            billing_time: 'calendar',
            ending_at: new Date(
              Date.now() + 30 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
        });
        return data.subscription;
      } catch (error) {
        this.logger.error('Error occured in subscription plan', error);
        await this.throwMappedError(error, {
          notFound: 'Plan not found',
          badRequest: 'Bad request',
          unavailable: 'Lago subscription creation unavailable',
        });
      }
    });
  }

  async cancelSubscription(
    externalId: string,
    onTerminationInvoice: 'generate' | 'skip' = 'skip',
  ): Promise<void> {
    return await this.fireMutate(async () => {
      try {
        await this.lago.subscriptions.destroySubscription(externalId, {
          on_termination_invoice: onTerminationInvoice,
        });
      } catch (error) {
        this.logger.error(
          `Error occured in cancel subscription for externalId=${externalId}`,
          error,
        );
        await this.throwMappedError(error, {
          notFound: 'Subscription not found',
          badRequest: 'Bad request',
          unavailable: 'Lago subscription cancellation unavailable',
        });
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async getCredits(account: Account) {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.wallets.findWallet(account.walletId);
        return { credits: data.wallet.credits_balance };
      } catch (error) {
        this.logger.error(
          `Error occured in get credits of walletId: ${account.walletId}`,
          error,
        );
        throw new HttpException('Bad request', 400);
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async getSubscription(account: Account) {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.subscriptions.findSubscription(
          account.id,
        );
        return { subscription: data.subscription };
      } catch (error) {
        const lagoError =
          await getLagoError<typeof this.lago.subscriptions.findSubscription>(
            error,
          );
        if (lagoError?.error === 'Not Found') {
          throw new HttpException('Plan not found', 404);
        } else {
          this.logger.error('Error occured in get subscription', error);
          throw new HttpException('Bad request', 400);
        }
      }
    });
  }

  async checkCoupon(code: string): Promise<{ coupon: CachedCoupon }> {
    return await this.fireRead(async () => {
      const coupon = await this.findCouponOrThrow(code);
      if (this.isExpired(coupon)) {
        throw new HttpException('This coupon is expired', 400);
      }
      return {
        coupon: {
          name: coupon.name,
          description: coupon.description,
          code: coupon.code,
          type: coupon.coupon_type,
          planCodes: coupon.plan_codes,
          amountCents: coupon.amount_cents,
          reusable: coupon.reusable,
          percentageRate: coupon.percentage_rate,
          frequency: coupon.frequency,
          frequencyDuration: coupon.frequency_duration,
          expirationAt: coupon.expiration_at,
        },
      };
    });
  }

  private async findCouponOrThrow(code: string): Promise<CouponObject> {
    try {
      const { data } = await this.lago.coupons.findCoupon(code);
      return data.coupon;
    } catch (error) {
      this.logger.error('Error occurred in check coupon', error);
      await this.throwMappedError(error, {
        notFound: 'Coupon not found',
        badRequest: 'Bad request',
        unavailable: 'Lago coupon lookup unavailable',
      });
    }
  }

  async getCoupons(): Promise<{ coupons: CachedCoupon[] }> {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.coupons.findAllCoupons();
        return {
          coupons: data.coupons.map((c) => ({
            name: c.name,
            description: c.description,
            code: c.code,
            type: c.coupon_type,
            planCodes: c.plan_codes,
            amountCents: c.amount_cents,
            reusable: c.reusable,
            percentageRate: c.percentage_rate,
            frequency: c.frequency,
            frequencyDuration: c.frequency_duration,
            expirationAt: c.expiration_at,
          })),
        };
      } catch (error) {
        this.logger.error('Error occurred in get coupons', error);
        await this.throwMappedError(error, {
          badRequest: 'Bad request',
          unavailable: 'Lago coupons unavailable',
        });
      }
    });
  }

  async checkPlan(code: string): Promise<{ plan: CachedPlan }> {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.plans.findPlan(code);
        return {
          plan: {
            name: data.plan.name,
            description: data.plan.description,
            code: data.plan.code,
            interval: data.plan.interval,
            payInAdvance: data.plan.pay_in_advance,
            amountCents: data.plan.amount_cents,
            amountCurrency: data.plan.amount_currency,
            trialPeriod: data.plan.trial_period,
            charges: data.plan.charges,
          },
        };
      } catch (error) {
        this.logger.error('Error occurred in check plan', error);
        await this.throwMappedError(error, {
          notFound: 'Plan not found',
          badRequest: 'Bad request',
          unavailable: 'Lago plan lookup unavailable',
        });
      }
    });
  }

  async getPlans(): Promise<{ plans: CachedPlan[] }> {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.plans.findAllPlans();
        return {
          plans: data.plans.map((p) => ({
            name: p.name,
            description: p.description,
            code: p.code,
            interval: p.interval,
            payInAdvance: p.pay_in_advance,
            amountCents: p.amount_cents,
            amountCurrency: p.amount_currency,
            trialPeriod: p.trial_period,
            charges: p.charges,
          })),
        };
      } catch (error) {
        this.logger.error('Error occurred in get plans', error);
        await this.throwMappedError(error, {
          badRequest: 'Bad request',
          unavailable: 'Lago plans unavailable',
        });
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async spendBarcodeCredits(account: Account, credits: number) {
    return await this.fireMutate(async () => {
      try {
        const { data } =
          await this.lago.walletTransactions.createWalletTransaction({
            wallet_transaction: {
              wallet_id: account.walletId,
              voided_credits: `${credits}`,
            },
          });
        return data.wallet_transactions;
      } catch (error) {
        this.logger.error('Error occured in spend barcode credits', error);
        throw new HttpException('Bad request', 400);
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async payBarcodeCredits(account: Account, credits: number) {
    return await this.fireMutate(async () => {
      try {
        const { data } =
          await this.lago.walletTransactions.createWalletTransaction({
            wallet_transaction: {
              wallet_id: account.walletId,
              paid_credits: `${credits}`,
            },
          });
        return data.wallet_transactions;
      } catch (error) {
        this.logger.error('Error occured in pay barcode credits', error);
        throw new HttpException('Bad request', 400);
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async hasActiveSubscription(account: Account): Promise<boolean> {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.subscriptions.findAllSubscriptions({
          external_customer_id: account.id,
        });
        return (
          Array.isArray(data.subscriptions) && data.subscriptions.length > 0
        );
      } catch (error) {
        const lagoError =
          await getLagoError<
            typeof this.lago.subscriptions.findAllSubscriptions
          >(error);

        if (lagoError?.status === 404 || lagoError?.error === 'Not Found')
          return false;

        this.logger.error('Error checking subscriptions', error);
        throw new HttpException('Bad request', 400);
      }
    });
  }

  async getCustomerSubscriptions(
    accountId: string,
    statuses: Array<'active' | 'pending' | 'terminated' | 'canceled'> = [
      'active',
      'pending',
    ],
  ): Promise<SubscriptionObject[]> {
    return await this.fireRead(async () => {
      try {
        const { data } = await this.lago.subscriptions.findAllSubscriptions({
          external_customer_id: accountId,
          'status[]': statuses,
        });

        return data.subscriptions ?? [];
      } catch (error) {
        this.logger.error(
          `Error checking customer subscriptions for accountId=${accountId}`,
          error,
        );
        await this.throwMappedError(error, {
          notFound: 'Customer subscriptions not found',
          badRequest: 'Bad request',
          unavailable: 'Lago subscriptions unavailable',
        });
      }
    });
  }

  async checkHealth(): Promise<'ok' | 'error'> {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 3000);

    try {
      await this.lago.addOns.findAllAddOns(
        { per_page: 1, page: 1 },
        { signal: ac.signal },
      );

      return 'ok';
    } catch (error: unknown) {
      this.logger.error('Lago health check failed', error);
      return 'error';
    } finally {
      clearTimeout(timeout);
    }
  }

  // noinspection JSUnusedGlobalSymbols
  async createWallet(accountId: string) {
    return await this.fireMutate(async () => {
      try {
        const { data } = await this.lago.wallets.createWallet({
          wallet: {
            external_customer_id: accountId,
            name: 'Prepaid',
            rate_amount: '1',
            currency: 'USD',
          },
        });
        return data.wallet;
      } catch (error) {
        this.logger.error(
          `Error occured in create wallet for accountId=${accountId}`,
          error,
        );
        throw new Error(
          `Error occured in create wallet for accountId=${accountId}`,
        );
      }
    });
  }

  async createCustomer(accountId: string) {
    return await this.fireMutate(async () => {
      try {
        const { data } = await this.lago.customers.createCustomer({
          customer: {
            external_id: accountId,
          },
        });
        return data.customer;
      } catch (error) {
        this.logger.error(
          `Error occured during customer creation for accountId=${accountId}`,
          error,
        );
        throw new Error(
          `Error occured during customer creation for accountId=${accountId}`,
        );
      }
    });
  }

  // noinspection JSUnusedGlobalSymbols
  async terminateWallet(walletId: string) {
    return await this.fireMutate(async () => {
      try {
        const { data } = await this.lago.wallets.destroyWallet(walletId);
        return data.wallet;
      } catch (error) {
        this.logger.error(
          `Error occured in terminate wallet for walletId=${walletId}`,
          error,
        );
        throw new Error(
          `Error occured in terminate wallet for walletId=${walletId}`,
        );
      }
    });
  }

  async deleteCustomer(customerId: string) {
    return await this.fireMutate(async () => {
      try {
        const { data } = await this.lago.customers.destroyCustomer(customerId);
        return data.customer;
      } catch (error) {
        this.logger.error(
          `Error occured in delete customer for customerId=${customerId}`,
          error,
        );
        throw new Error(
          `Error occured during customer deletion for customerId=${customerId}`,
        );
      }
    });
  }

  async terminateExpiredSubscriptions(
    onTerminated?: (subscription: SubscriptionObject) => Promise<void>,
  ): Promise<{
    count: number;
    list: SubscriptionObject[];
  }> {
    let page = 1;
    const per_page = 100;
    let count = 0;
    const list: SubscriptionObject[] = [];
    const now = Date.now();
    let hasNextPage = true;

    while (hasNextPage) {
      const { data } = await this.lago.subscriptions.findAllSubscriptions({
        page,
        per_page,
        'status[]': ['active', 'pending'],
      });

      const subs: SubscriptionObject[] = data.subscriptions ?? [];
      if (subs.length === 0) break;

      for (const sub of subs) {
        try {
          if (!sub.ending_at) continue;
          const endsAt = Date.parse(sub.ending_at);
          if (Number.isNaN(endsAt)) {
            this.logger.warn(
              `Subscription ${sub.external_id} has invalid ending_at=${sub.ending_at}`,
            );
            continue;
          }
          if (endsAt > now) continue;

          await this.lago.subscriptions.destroySubscription(sub.external_id, {
            on_termination_invoice: 'generate',
          });

          count++;
          if (onTerminated) {
            await onTerminated(sub);
          } else {
            list.push(sub);
          }
          this.logger.log(
            `Terminated subscription external_id=${sub.external_id} (status=${sub.status}, ending_at=${sub.ending_at})`,
          );
        } catch (error) {
          const lagoError =
            await getLagoError<
              typeof this.lago.subscriptions.destroySubscription
            >(error);
          if (lagoError) {
            this.logger.error(
              `Failed terminating subscription external_id=${sub.external_id}: ${lagoError.error} (${lagoError.status})`,
            );
          } else {
            this.logger.error(
              `Unexpected error terminating subscription external_id=${sub.external_id}`,
              error,
            );
          }
        }
      }

      hasNextPage = subs.length === per_page;
      if (hasNextPage) {
        page++;
      }
    }

    return { count, list };
  }

  async terminateExpiredCoupons(
    onTerminated?: (coupon: CouponObject) => Promise<void>,
  ): Promise<{
    count: number;
    list: CouponObject[];
  }> {
    let page = 1;
    const per_page = 100;
    let count = 0;
    const list: CouponObject[] = [];
    let hasNextPage = true;

    while (hasNextPage) {
      const { data } = await this.lago.coupons.findAllCoupons({
        page,
        per_page,
      });

      const coupons: CouponObject[] = data.coupons ?? [];
      if (coupons.length === 0) break;

      for (const coupon of coupons) {
        try {
          if (coupon.terminated_at) continue;

          const endsAt =
            coupon.expiration === 'time_limit' && coupon.expiration_at
              ? Date.parse(coupon.expiration_at)
              : undefined;

          if (endsAt !== undefined && Number.isNaN(endsAt)) {
            this.logger.warn(
              `Coupon ${coupon.code} has invalid expiration_at=${coupon.expiration_at}`,
            );
            continue;
          }

          if (!this.isExpired(coupon)) {
            continue;
          }

          await this.lago.coupons.destroyCoupon(coupon.code);

          count++;
          if (onTerminated) {
            await onTerminated(coupon);
          } else {
            list.push(coupon);
          }
          this.logger.log(
            `Terminated coupon code=${coupon.code} (name=${coupon.name ?? '—'}, expiration=${coupon.expiration}, expiration_at=${coupon.expiration_at ?? '—'})`,
          );
        } catch (error) {
          const lagoError =
            await getLagoError<typeof this.lago.coupons.destroyCoupon>(error);

          if (lagoError) {
            this.logger.error(
              `Failed terminating coupon code=${coupon.code}: ${lagoError.error} (${lagoError.status})`,
            );
          } else {
            this.logger.error(
              `Unexpected error terminating coupon code=${coupon.code}`,
              error,
            );
          }
        }
      }

      hasNextPage = coupons.length === per_page;
      if (hasNextPage) {
        page++;
      }
    }

    return { count, list };
  }
}
