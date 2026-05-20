-- Migration: add EXPIRE to CreditOperation enum, FAILED to SagaStatus enum
-- Required by ТЗ (Приложение A) and bugs_and_fixes.md BUG-3 / MINOR-5

ALTER TYPE "CreditOperation" ADD VALUE IF NOT EXISTS 'EXPIRE';
ALTER TYPE "SagaStatus" ADD VALUE IF NOT EXISTS 'FAILED';

