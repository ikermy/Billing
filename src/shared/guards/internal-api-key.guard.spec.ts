import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';

describe('InternalApiKeyGuard', () => {
  let guard: InternalApiKeyGuard;

  const createContext = (headerValue?: string | string[]): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers:
            headerValue === undefined
              ? {}
              : { 'x-internal-api-key': headerValue },
        }),
      }),
    }) as ExecutionContext;

  beforeEach(() => {
    delete process.env.INTERNAL_API_KEY;
    guard = new InternalApiKeyGuard();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  it('allows requests with a matching internal api key', () => {
    process.env.INTERNAL_API_KEY = 'super-secure-internal-api-key-1234567890';

    expect(
      guard.canActivate(
        createContext('super-secure-internal-api-key-1234567890'),
      ),
    ).toBe(true);
  });

  it('rejects requests with a missing key', () => {
    process.env.INTERNAL_API_KEY = 'super-secure-internal-api-key-1234567890';

    expect(() => guard.canActivate(createContext())).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects requests with an invalid key', () => {
    process.env.INTERNAL_API_KEY = 'super-secure-internal-api-key-1234567890';

    expect(() => guard.canActivate(createContext('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when internal api key is not configured', () => {
    expect(() => guard.canActivate(createContext('anything'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('fails closed when internal api key is insecure', () => {
    process.env.INTERNAL_API_KEY = 'change-me-internal';

    expect(() =>
      guard.canActivate(createContext('change-me-internal')),
    ).toThrow(ServiceUnavailableException);
  });
});
