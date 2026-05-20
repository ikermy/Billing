import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { isWeakSharedSecret } from 'src/shared/utils/secret.util';

type RequestWithHeaders = {
  headers?: Record<string, string | string[] | undefined>;
};

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedKey = process.env.INTERNAL_API_KEY;
    if (!expectedKey || isWeakSharedSecret(expectedKey)) {
      throw new ServiceUnavailableException(
        'Internal API key is not securely configured',
      );
    }

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const providedHeader = request.headers?.['x-internal-api-key'];
    const providedKey = Array.isArray(providedHeader)
      ? providedHeader[0]
      : providedHeader;

    if (!this.isValidKey(providedKey, expectedKey)) {
      throw new UnauthorizedException('Invalid internal API key');
    }

    return true;
  }

  private isValidKey(
    providedKey: string | undefined,
    expectedKey: string,
  ): boolean {
    if (!providedKey) {
      return false;
    }

    const providedBuffer = Buffer.from(providedKey);
    const expectedBuffer = Buffer.from(expectedKey);

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }
}
