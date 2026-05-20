import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreditType, QuoteRequestDto, QuoteSource } from './quote.dto';

describe('QuoteRequestDto', () => {
  it('accepts any string userId (BFF sends non-UUID user IDs)', async () => {
    /**
     * userId is @IsOptional() @IsString() — NOT @IsUUID().
     * BFF sends arbitrary user IDs so UUID validation must NOT be present.
     */
    const dto = plainToInstance(QuoteRequestDto, {
      userId: 'not-a-uuid',
      units: 5,
      creditType: CreditType.BARCODE,
      context: {
        product: 'barcode_pdf417',
        revision: 'US_CA_08292017',
        source: QuoteSource.SINGLE,
      },
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'userId')).toBe(false);
  });

  it('accepts request without userId (BFF may omit it)', async () => {
    const dto = plainToInstance(QuoteRequestDto, { units: 5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'userId')).toBe(false);
  });

  it('rejects units below 1', async () => {
    const dto = plainToInstance(QuoteRequestDto, { units: 0 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'units')).toBe(true);
  });
});
