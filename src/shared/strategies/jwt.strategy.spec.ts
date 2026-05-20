import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  afterEach(() => {
    delete process.env.JWT_ACCESS_SECRET;
  });

  it('fails fast when jwt secret is insecure', () => {
    process.env.JWT_ACCESS_SECRET = 'change-me';

    expect(() => new JwtStrategy()).toThrow(
      'JWT_ACCESS_SECRET must be set to a strong random value (32+ chars)',
    );
  });

  it('returns normalized user data for valid payloads', () => {
    process.env.JWT_ACCESS_SECRET = 'super-secure-jwt-secret-value-1234567890';
    const strategy = new JwtStrategy();

    expect(
      strategy.validate({
        sub: 'user-1',
        role: 'ADMIN',
      }),
    ).toEqual({
      id: 'user-1',
      role: 'ADMIN',
    });
  });

  it('rejects banned users', () => {
    process.env.JWT_ACCESS_SECRET = 'super-secure-jwt-secret-value-1234567890';
    const strategy = new JwtStrategy();

    expect(() =>
      strategy.validate({
        sub: 'user-1',
        isBanned: true,
      }),
    ).toThrow(ForbiddenException);
  });

  it('rejects payloads without an id', () => {
    process.env.JWT_ACCESS_SECRET = 'super-secure-jwt-secret-value-1234567890';
    const strategy = new JwtStrategy();

    expect(() => strategy.validate({ role: 'USER' })).toThrow(
      UnauthorizedException,
    );
  });
});
