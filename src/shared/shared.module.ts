import { Global, Module } from '@nestjs/common';
import { PrismaService } from './services/prisma.service';
import { LagoService } from './services/lago.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { RedisService } from './services/redis.service';
import { WalletBalanceService } from './services/wallet-balance.service';
import { CreditLedgerService } from './services/credit-ledger.service';
import { PricingService } from './services/pricing.service';
import { BillingConfigService } from './services/billing-config.service';
import { SubscriptionService } from './services/subscription.service';
import { PaymentLedgerService } from './services/payment-ledger.service';
import { AdminGuard } from './guards/admin.guard';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';
import {
  BillingMetricsService,
  BILLING_METRICS_PROVIDERS,
} from './services/billing-metrics.service';

@Global()
@Module({
  imports: [JwtModule],
  providers: [
    PrismaService,
    LagoService,
    JwtStrategy,
    JwtService,
    RedisService,
    WalletBalanceService,
    CreditLedgerService,
    PricingService,
    BillingConfigService,
    SubscriptionService,
    PaymentLedgerService,
    AdminGuard,
    InternalApiKeyGuard,
    BillingMetricsService,
    ...BILLING_METRICS_PROVIDERS,
  ],
  exports: [
    PrismaService,
    LagoService,
    JwtStrategy,
    JwtService,
    RedisService,
    WalletBalanceService,
    CreditLedgerService,
    PricingService,
    BillingConfigService,
    SubscriptionService,
    PaymentLedgerService,
    AdminGuard,
    InternalApiKeyGuard,
    BillingMetricsService,
  ],
})
export class SharedModule {}
