import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { isWeakSharedSecret } from 'src/shared/utils/secret.util';

type JwtPayload = {
  id?: string;
  sub?: string;
  role?: string;
  isBanned?: boolean;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (isWeakSharedSecret(secret)) {
      throw new Error(
        'JWT_ACCESS_SECRET must be set to a strong random value (32+ chars)',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload): { id: string; role: string } {
    if (payload.isBanned) {
      throw new ForbiddenException('User is banned');
    }

    const id = payload.id ?? payload.sub;
    if (!id) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const role = typeof payload.role === 'string' ? payload.role : 'USER';

    return {
      id,
      role,
    };
  }
}
