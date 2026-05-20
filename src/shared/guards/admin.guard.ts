// admin.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

type JwtUser = {
  id: string;
  role: 'USER' | 'ADMIN';
};

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: JwtUser }>();
    const user = req.user;

    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Access denied: Admins only');
    }
    return true;
  }
}
