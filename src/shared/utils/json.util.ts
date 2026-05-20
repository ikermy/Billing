import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Recursively converts an unknown value to a Prisma-compatible JSON value.
 * Returns `undefined` if value is `undefined` (useful for optional metadata fields).
 *
 * @param value - The value to normalize
 * @param errorMessage - Error message thrown when value is not a valid JSON type
 */
export function normalizeJsonValue(
  value: unknown,
  errorMessage = 'Value must be valid JSON',
): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item, errorMessage) ?? null);
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeJsonValue(item, errorMessage) ?? null,
      ]),
    );
  }

  throw new BadRequestException(errorMessage);
}
