import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import { SubscriptionObject } from 'lago-javascript-client';
import { PrismaService } from './prisma.service';
import { LagoService } from './lago.service';
import { RedisService } from './redis.service';
import { normalizeJsonValue } from 'src/shared/utils/json.util';

type SubscriptionWithPlan = Subscription & {
  plan: SubscriptionPlan;
};

type CreateSubscriptionPlanInput = {
  lagoPlanCode: string;
  monthlyCredits: number;
  isActive?: boolean;
  features?: unknown;
};

type UpdateSubscriptionPlanInput = {
  monthlyCredits?: number;
  isActive?: boolean;
  features?: unknown;
};

type SubscriptionSummary = {
  active: boolean;
  status: SubscriptionStatus;
  plan: string;
  planCode: string;
  allocated: number;
  used: number;
  remaining: number;
  startsAt: string;
  expiresAt: string;
};

@Injectable()
export class SubscriptionService {
  private readonly defaultPeriodMs = 30 * 24 * 60 * 60 * 1000;
  private readonly syncMarkerTtlSeconds = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lago: LagoService,
    private readonly redis: RedisService,
  ) {}

  async listPlans(): Promise<SubscriptionPlan[]> {
    return await this.prisma.subscriptionPlan.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  async createPlanFromLago(
    input: CreateSubscriptionPlanInput,
  ): Promise<SubscriptionPlan> {
    this.assertPositiveInteger(input.monthlyCredits, 'monthlyCredits');
    const features = normalizeJsonValue(
      input.features,
      'Subscription plan features must be valid JSON',
    );

    const { plan } = await this.lago.checkPlan(input.lagoPlanCode);

    return await this.prisma.subscriptionPlan.upsert({
      where: { lagoPlanCode: input.lagoPlanCode },
      update: {
        name: plan.name,
        priceMonthly: new Prisma.Decimal(plan.amountCents / 100),
        currency: plan.amountCurrency,
        monthlyCredits: input.monthlyCredits,
        isActive: input.isActive ?? true,
        features,
      },
      create: {
        name: plan.name,
        lagoPlanCode: input.lagoPlanCode,
        monthlyCredits: input.monthlyCredits,
        priceMonthly: new Prisma.Decimal(plan.amountCents / 100),
        currency: plan.amountCurrency,
        isActive: input.isActive ?? true,
        features,
      },
    });
  }

  async updatePlan(
    id: string,
    input: UpdateSubscriptionPlanInput,
  ): Promise<SubscriptionPlan> {
    const existing = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Subscription plan not found');
    }

    if (input.monthlyCredits !== undefined) {
      this.assertPositiveInteger(input.monthlyCredits, 'monthlyCredits');
    }
    const features = normalizeJsonValue(
      input.features,
      'Subscription plan features must be valid JSON',
    );

    const { plan } = await this.lago.checkPlan(existing.lagoPlanCode);

    return await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: plan.name,
        priceMonthly: new Prisma.Decimal(plan.amountCents / 100),
        currency: plan.amountCurrency,
        monthlyCredits: input.monthlyCredits ?? existing.monthlyCredits,
        isActive: input.isActive ?? existing.isActive,
        features: features ?? existing.features ?? undefined,
      },
    });
  }

  async deactivatePlan(id: string): Promise<SubscriptionPlan> {
    const existing = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Subscription plan not found');
    }

    return await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        isActive: false,
      },
    });
  }

  async requireActivePlan(code: string): Promise<SubscriptionPlan> {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { lagoPlanCode: code },
    });

    if (!plan?.isActive) {
      throw new HttpException(
        'Subscription plan is not configured for local limits',
        HttpStatus.CONFLICT,
      );
    }

    return plan;
  }

  async activateSubscription(
    accountId: string,
    remote: SubscriptionObject,
  ): Promise<SubscriptionWithPlan> {
    const plan = await this.ensurePlanProjection(remote.plan_code);
    const subscription = await this.upsertRemoteSubscription(
      accountId,
      remote,
      plan,
    );
    await this.markProjectionFresh(accountId);
    return subscription;
  }

  async getSummary(accountId: string): Promise<SubscriptionSummary | false> {
    await this.ensureProjectionFresh(accountId);

    const subscription = await this.prisma.subscription.findFirst({
      where: { accountId },
      include: { plan: true },
      orderBy: [{ currentPeriodEnd: 'desc' }, { createdAt: 'desc' }],
    });

    if (!subscription) {
      return false;
    }

    const remaining = Math.max(
      0,
      subscription.creditsAllocated - subscription.creditsUsed,
    );
    const active = this.isUsableSubscription(subscription);

    return {
      active,
      status: subscription.status,
      plan: subscription.plan.name,
      planCode: subscription.plan.lagoPlanCode,
      allocated: subscription.creditsAllocated,
      used: subscription.creditsUsed,
      remaining: active ? remaining : 0,
      startsAt: subscription.currentPeriodStart.toISOString(),
      expiresAt: subscription.currentPeriodEnd.toISOString(),
    };
  }

  async hasCurrentSubscription(accountId: string): Promise<boolean> {
    const summary = await this.getSummary(accountId);
    return Boolean(summary && summary.active);
  }

  async getRemainingCredits(accountId: string): Promise<{
    subscription: SubscriptionWithPlan | null;
    remaining: number;
  }> {
    await this.ensureProjectionFresh(accountId);
    const subscription = await this.getUsableSubscription(accountId);

    if (!subscription) {
      return { subscription: null, remaining: 0 };
    }

    return {
      subscription,
      remaining: Math.max(
        0,
        subscription.creditsAllocated - subscription.creditsUsed,
      ),
    };
  }

  async reserveGenerations(
    accountId: string,
    amount: number,
  ): Promise<SubscriptionWithPlan | null> {
    this.assertPositiveInteger(amount, 'amount');
    await this.ensureProjectionFresh(accountId);

    const subscription = await this.getUsableSubscription(accountId);
    if (!subscription) {
      return null;
    }

    const updated = await this.prisma.$executeRaw`
      UPDATE "Subscription"
      SET "creditsUsed" = "creditsUsed" + ${amount},
          "updatedAt" = NOW()
      WHERE "id" = ${subscription.id}
        AND "status" = ${SubscriptionStatus.ACTIVE}::"SubscriptionStatus"
        AND "currentPeriodStart" <= NOW()
        AND "currentPeriodEnd" > NOW()
        AND ("creditsAllocated" - "creditsUsed") >= ${amount}
    `;

    if (updated === 0) {
      return null;
    }

    return await this.getSubscriptionById(subscription.id);
  }

  async consumeIncludedCredits(
    accountId: string,
    amount: number,
  ): Promise<SubscriptionWithPlan | null> {
    return await this.reserveGenerations(accountId, amount);
  }

  async releaseGenerations(
    subscriptionId: string,
    amount: number,
  ): Promise<SubscriptionWithPlan | null> {
    this.assertPositiveInteger(amount, 'amount');

    const updated = await this.prisma.subscription.updateMany({
      where: {
        id: subscriptionId,
        creditsUsed: {
          gte: amount,
        },
      },
      data: {
        creditsUsed: {
          decrement: amount,
        },
      },
    });

    if (updated.count === 0) {
      return null;
    }

    return await this.getSubscriptionById(subscriptionId);
  }

  async expireEndedSubscriptions(): Promise<{
    count: number;
    items: Array<{
      id: string;
      accountId: string;
      planCode: string;
      userId: string;
    }>;
  }> {
    const now = new Date();
    const toExpire = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: { lte: now },
      },
      include: {
        plan: { select: { lagoPlanCode: true } },
        account: { select: { userId: true } },
      },
    });

    if (toExpire.length === 0) return { count: 0, items: [] };

    await this.prisma.subscription.updateMany({
      where: { id: { in: toExpire.map((s) => s.id) } },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    return {
      count: toExpire.length,
      items: toExpire.map((s) => ({
        id: s.id,
        accountId: s.accountId,
        planCode: s.plan.lagoPlanCode,
        userId: s.account.userId,
      })),
    };
  }

  async cancelLocalSubscription(externalId: string): Promise<{
    count: number;
    items: Array<{
      id: string;
      accountId: string;
      planCode: string;
      userId: string;
    }>;
  }> {
    const toCancel = await this.prisma.subscription.findMany({
      where: {
        lagoExternalId: externalId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.PAST_DUE,
          ],
        },
      },
      include: {
        plan: { select: { lagoPlanCode: true } },
        account: { select: { userId: true } },
      },
    });

    if (toCancel.length === 0) return { count: 0, items: [] };

    await this.prisma.subscription.updateMany({
      where: { id: { in: toCancel.map((s) => s.id) } },
      data: { status: SubscriptionStatus.CANCELLED },
    });

    return {
      count: toCancel.length,
      items: toCancel.map((s) => ({
        id: s.id,
        accountId: s.accountId,
        planCode: s.plan.lagoPlanCode,
        userId: s.account.userId,
      })),
    };
  }

  private async syncAccountSubscription(
    accountId: string,
  ): Promise<SubscriptionWithPlan | null> {
    let remoteSubscriptions: SubscriptionObject[];
    try {
      remoteSubscriptions = await this.lago.getCustomerSubscriptions(
        accountId,
        ['active', 'pending', 'terminated', 'canceled'],
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 404) {
        remoteSubscriptions = [];
      } else {
        throw error;
      }
    }
    const remote = this.pickPrimarySubscription(remoteSubscriptions);

    if (!remote) {
      await this.expireStaleSubscriptions(accountId);
      await this.markProjectionFresh(accountId);
      return null;
    }

    const plan = await this.ensurePlanProjection(remote.plan_code);
    const subscription = await this.upsertRemoteSubscription(
      accountId,
      remote,
      plan,
    );
    await this.markProjectionFresh(accountId);
    return subscription;
  }

  private async ensureProjectionFresh(accountId: string): Promise<void> {
    const marker = await this.redis.getJson<boolean>(
      this.getProjectionSyncKey(accountId),
    );
    if (marker) {
      return;
    }

    await this.syncAccountSubscription(accountId);
  }

  private async ensurePlanProjection(code: string): Promise<SubscriptionPlan> {
    const existing = await this.prisma.subscriptionPlan.findUnique({
      where: { lagoPlanCode: code },
    });
    const { plan } = await this.lago.checkPlan(code);

    return await this.prisma.subscriptionPlan.upsert({
      where: { lagoPlanCode: code },
      update: {
        name: plan.name,
        priceMonthly: new Prisma.Decimal(plan.amountCents / 100),
        currency: plan.amountCurrency,
      },
      create: {
        name: plan.name,
        lagoPlanCode: code,
        monthlyCredits: existing?.monthlyCredits ?? 0,
        priceMonthly: new Prisma.Decimal(plan.amountCents / 100),
        currency: plan.amountCurrency,
        isActive: existing?.isActive ?? true,
        features:
          existing?.features ??
          ({
            needsMonthlyCreditsConfiguration: true,
          } satisfies Prisma.InputJsonValue),
      },
    });
  }

  private async upsertRemoteSubscription(
    accountId: string,
    remote: SubscriptionObject,
    plan: SubscriptionPlan,
  ): Promise<SubscriptionWithPlan> {
    const currentPeriodStart = this.parseDate(
      remote.current_billing_period_started_at ??
        remote.started_at ??
        remote.subscription_at ??
        remote.created_at,
      new Date(),
    );
    const currentPeriodEnd = this.parseDate(
      remote.current_billing_period_ending_at ?? remote.ending_at,
      new Date(currentPeriodStart.getTime() + this.defaultPeriodMs),
    );
    const status = this.mapRemoteStatus(remote, currentPeriodEnd);

    const existing = await this.prisma.subscription.findFirst({
      where: {
        OR: [
          { lagoSubscriptionId: remote.lago_id },
          { lagoExternalId: remote.external_id },
        ],
      },
      include: { plan: true },
    });
    const samePeriod =
      Boolean(existing) &&
      existing.currentPeriodStart.getTime() === currentPeriodStart.getTime() &&
      existing.currentPeriodEnd.getTime() === currentPeriodEnd.getTime();
    const nextCreditsUsed = samePeriod
      ? Math.min(existing.creditsUsed, plan.monthlyCredits)
      : 0;

    const subscription = existing
      ? await this.prisma.subscription.update({
          where: { id: existing.id },
          data: {
            planId: plan.id,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            creditsAllocated: plan.monthlyCredits,
            creditsUsed: nextCreditsUsed,
            lagoSubscriptionId: remote.lago_id,
            lagoExternalId: remote.external_id,
          },
          include: { plan: true },
        })
      : await this.prisma.subscription.create({
          data: {
            accountId,
            planId: plan.id,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            creditsAllocated: plan.monthlyCredits,
            creditsUsed: 0,
            lagoSubscriptionId: remote.lago_id,
            lagoExternalId: remote.external_id,
          },
          include: { plan: true },
        });

    await this.prisma.subscription.updateMany({
      where: {
        accountId,
        id: {
          not: subscription.id,
        },
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
        },
      },
      data: {
        status:
          status === SubscriptionStatus.ACTIVE
            ? SubscriptionStatus.EXPIRED
            : status,
      },
    });

    return subscription;
  }

  private async expireStaleSubscriptions(accountId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: {
        accountId,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
        },
      },
      data: {
        status: SubscriptionStatus.EXPIRED,
      },
    });
  }

  private async markProjectionFresh(accountId: string): Promise<void> {
    await this.redis.set(
      this.getProjectionSyncKey(accountId),
      true,
      this.syncMarkerTtlSeconds,
    );
  }

  private getProjectionSyncKey(accountId: string): string {
    return `billing:subscription:sync:${accountId}`;
  }

  private async getUsableSubscription(
    accountId: string,
  ): Promise<SubscriptionWithPlan | null> {
    const now = new Date();

    return await this.prisma.subscription.findFirst({
      where: {
        accountId,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: {
          lte: now,
        },
        currentPeriodEnd: {
          gt: now,
        },
        plan: {
          is: {
            isActive: true,
          },
        },
      },
      include: { plan: true },
      orderBy: [{ currentPeriodEnd: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async getSubscriptionById(
    id: string,
  ): Promise<SubscriptionWithPlan | null> {
    return await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true },
    });
  }

  private pickPrimarySubscription(
    subscriptions: SubscriptionObject[],
  ): SubscriptionObject | null {
    if (subscriptions.length === 0) {
      return null;
    }

    const statusRank: Record<SubscriptionObject['status'], number> = {
      active: 0,
      pending: 1,
      canceled: 2,
      terminated: 3,
    };

    return [...subscriptions].sort((left, right) => {
      const rankDiff = statusRank[left.status] - statusRank[right.status];
      if (rankDiff !== 0) {
        return rankDiff;
      }

      const leftDate = this.parseDate(
        left.current_billing_period_ending_at ??
          left.ending_at ??
          left.created_at,
        new Date(0),
      ).getTime();
      const rightDate = this.parseDate(
        right.current_billing_period_ending_at ??
          right.ending_at ??
          right.created_at,
        new Date(0),
      ).getTime();

      return rightDate - leftDate;
    })[0];
  }

  private mapRemoteStatus(
    remote: SubscriptionObject,
    currentPeriodEnd: Date,
  ): SubscriptionStatus {
    if (remote.status === 'terminated') {
      return currentPeriodEnd <= new Date()
        ? SubscriptionStatus.EXPIRED
        : SubscriptionStatus.CANCELLED;
    }

    if (remote.status === 'canceled') {
      return SubscriptionStatus.CANCELLED;
    }

    return SubscriptionStatus.ACTIVE;
  }

  private isUsableSubscription(subscription: SubscriptionWithPlan): boolean {
    const now = new Date();

    return (
      subscription.status === SubscriptionStatus.ACTIVE &&
      subscription.plan.isActive &&
      subscription.currentPeriodStart <= now &&
      subscription.currentPeriodEnd > now
    );
  }

  private parseDate(raw: string | null | undefined, fallback: Date): Date {
    if (!raw) {
      return fallback;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }

  private assertPositiveInteger(value: number, field: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HttpException(
        `${field} must be a positive integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
