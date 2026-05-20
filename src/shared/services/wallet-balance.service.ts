import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { createCircuitBreaker } from 'src/shared/utils/circuit-breaker.factory';

export type WalletBalance = {
  available: number;
  blocked?: number;
  currency: string;
};

export type WalletBlockRequest = {
  userId: string;
  amount: number;
  currency?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type WalletBlockResponse = {
  blockId: string;
  amount: number;
  currency: string;
  expiresAt?: string;
};

export type TopUpRequest = {
  userId: string;
  amount: number;
  bonusPercent?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
};

export type TopUpResponse = {
  balance: number;
  creditedAmount: number;
  bonusAmount: number;
  currency: string;
};

type WalletBalancePayload = {
  available?: number | string;
  balance?: number | string;
  blocked?: number | string;
  currency?: string;
};

type WalletBlockPayload = {
  blockId?: string;
  id?: string;
  amount?: number | string;
  currency?: string;
  expiresAt?: string;
};

type WalletTopUpPayload = {
  balance?: number | string;
  creditedAmount?: number | string;
  amount?: number | string;
  bonusAmount?: number | string;
  currency?: string;
};

@Injectable()
export class WalletBalanceService implements OnModuleInit {
  private readonly logger = new Logger(WalletBalanceService.name);
  private readonly baseUrl = process.env.WALLET_BALANCE_URL;
  private readonly apiKey = process.env.WALLET_BALANCE_API_KEY;
  private readonly client: AxiosInstance | null;

  // Circuit breakers – one per operation category
  private cbGet!: CircuitBreaker;
  private cbBlock!: CircuitBreaker;
  private cbConfirm!: CircuitBreaker;
  private cbCancel!: CircuitBreaker;
  private cbTopUp!: CircuitBreaker;

  constructor() {
    this.client = this.baseUrl
      ? axios.create({
          baseURL: this.baseUrl,
          timeout: 5000,
          headers: this.apiKey
            ? {
                Authorization: `Bearer ${this.apiKey}`,
                'X-API-Key': this.apiKey,
              }
            : undefined,
        })
      : null;
  }

  onModuleInit(): void {
    const cbDefaults = {
      errorThresholdPercentage: 50,
      resetTimeout: 10_000,
      timeout: 5_000,
      volumeThreshold: 5,
    };

    const getBalanceHandler = async (userId: string): Promise<WalletBalance> =>
      await this._getBalance(userId);
    const blockFundsHandler = async (
      request: WalletBlockRequest,
    ): Promise<WalletBlockResponse> => await this._blockFunds(request);
    const confirmBlockHandler = async (blockId: string): Promise<void> =>
      await this._confirmBlock(blockId);
    const cancelBlockHandler = async (blockId: string): Promise<void> =>
      await this._cancelBlock(blockId);
    const topUpHandler = async (
      request: TopUpRequest,
    ): Promise<TopUpResponse> => await this._topUpWithBonus(request);

    this.cbGet = createCircuitBreaker(getBalanceHandler, {
      name: 'wallet.getBalance',
      ...cbDefaults,
    });
    this.cbBlock = createCircuitBreaker(blockFundsHandler, {
      name: 'wallet.blockFunds',
      ...cbDefaults,
    });
    this.cbConfirm = createCircuitBreaker(confirmBlockHandler, {
      name: 'wallet.confirmBlock',
      ...cbDefaults,
    });
    this.cbCancel = createCircuitBreaker(cancelBlockHandler, {
      name: 'wallet.cancelBlock',
      ...cbDefaults,
    });
    this.cbTopUp = createCircuitBreaker(topUpHandler, {
      name: 'wallet.topUp',
      ...cbDefaults,
    });
  }

  isEnabled(): boolean {
    return Boolean(this.client);
  }

  async getBalance(userId: string): Promise<WalletBalance> {
    return await (this.cbGet.fire(userId) as Promise<WalletBalance>);
  }

  async blockFunds(request: WalletBlockRequest): Promise<WalletBlockResponse> {
    return await (this.cbBlock.fire(request) as Promise<WalletBlockResponse>);
  }

  async confirmBlock(blockId: string): Promise<void> {
    return await (this.cbConfirm.fire(blockId) as Promise<void>);
  }

  async cancelBlock(blockId: string): Promise<void> {
    return await (this.cbCancel.fire(blockId) as Promise<void>);
  }

  async topUpWithBonus(request: TopUpRequest): Promise<TopUpResponse> {
    return await (this.cbTopUp.fire(request) as Promise<TopUpResponse>);
  }

  // ─── Internal implementations (called by circuit breakers) ────────────────

  private async _getBalance(userId: string): Promise<WalletBalance> {
    const client = this.getClient();
    try {
      const { data } = await client.get<WalletBalancePayload>(
        `/internal/wallets/${userId}/balance`,
      );
      return {
        available: this.parseFiniteNumber(
          data?.available ?? data?.balance,
          'available',
          0,
        ),
        blocked: this.parseOptionalFiniteNumber(data?.blocked, 'blocked'),
        currency: this.parseCurrency(data?.currency, 'USD'),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get wallet balance for userId=${userId}: ${getErrorMessage(error)}`,
      );
      throw new HttpException('Wallet balance unavailable', 503);
    }
  }

  private async _blockFunds(
    request: WalletBlockRequest,
  ): Promise<WalletBlockResponse> {
    const client = this.getClient();
    try {
      const { data } = await client.post<WalletBlockPayload>(
        '/internal/wallets/block',
        request,
      );
      return {
        blockId: this.requireNonEmptyString(
          data?.blockId ?? data?.id,
          'blockId',
        ),
        amount: this.parseFiniteNumber(data?.amount, 'amount', request.amount),
        currency: this.parseCurrency(data?.currency, request.currency ?? 'USD'),
        expiresAt: data?.expiresAt,
      };
    } catch (error) {
      this.logger.error(
        `Failed to block wallet funds for userId=${request.userId}: ${getErrorMessage(error)}`,
      );
      throw new HttpException('Wallet block failed', 503);
    }
  }

  private async _confirmBlock(blockId: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.post(`/internal/wallets/block/${blockId}/confirm`);
    } catch (error) {
      this.logger.error(
        `Failed to confirm wallet blockId=${blockId}: ${getErrorMessage(error)}`,
      );
      throw new HttpException('Wallet confirm failed', 503);
    }
  }

  private async _cancelBlock(blockId: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.post(`/internal/wallets/block/${blockId}/cancel`);
    } catch (error) {
      this.logger.error(
        `Failed to cancel wallet blockId=${blockId}: ${getErrorMessage(error)}`,
      );
      throw new HttpException('Wallet cancel failed', 503);
    }
  }

  private async _topUpWithBonus(request: TopUpRequest): Promise<TopUpResponse> {
    const client = this.getClient();

    try {
      const { data } = await client.post<WalletTopUpPayload>(
        '/internal/wallets/topup',
        request,
      );
      return {
        balance: this.parseFiniteNumber(data?.balance, 'balance', 0),
        creditedAmount: this.parseFiniteNumber(
          data?.creditedAmount ?? data?.amount,
          'creditedAmount',
          request.amount,
        ),
        bonusAmount: this.parseFiniteNumber(
          data?.bonusAmount,
          'bonusAmount',
          0,
        ),
        currency: this.parseCurrency(data?.currency, request.currency ?? 'USD'),
      };
    } catch (error) {
      this.logger.error(
        `Failed to top up wallet for userId=${request.userId}: ${getErrorMessage(error)}`,
      );
      throw new HttpException('Wallet top up failed', 503);
    }
  }

  async checkHealth(): Promise<'ok' | 'error'> {
    if (!this.client) {
      return 'ok';
    }

    try {
      await this.client.get('/healthz');
      return 'ok';
    } catch (error) {
      this.logger.error(
        `Wallet health check failed: ${getErrorMessage(error)}`,
      );
      return 'error';
    }
  }

  private getClient(): AxiosInstance {
    if (!this.client) {
      throw new HttpException('Wallet service is not configured', 503);
    }

    return this.client;
  }

  private parseFiniteNumber(
    value: unknown,
    field: string,
    fallback?: number,
  ): number {
    if (value === undefined || value === null || value === '') {
      if (fallback !== undefined) {
        return fallback;
      }

      throw new Error(`Wallet response missing ${field}`);
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Wallet response contains invalid ${field}`);
    }

    return parsed;
  }

  private parseOptionalFiniteNumber(
    value: unknown,
    field: string,
  ): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return this.parseFiniteNumber(value, field);
  }

  private parseCurrency(value: unknown, fallback: string): string {
    if (value === undefined || value === null) {
      return fallback;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    throw new Error('Wallet response contains invalid currency');
  }

  private requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    throw new Error(`Wallet response missing ${field}`);
  }
}
