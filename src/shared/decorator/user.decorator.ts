import { createParamDecorator, ExecutionContext } from '@nestjs/common';

type RequestUser = Record<string, unknown>;
type RequestWithUser = {
  user?: RequestUser;
};

export const User = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext): unknown => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    return data ? user?.[data] : user;
  },
);
