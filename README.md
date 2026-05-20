# Barcode Gen — Billing Service

NestJS-сервис биллинга для платформы генерации штрихкодов.  
Управляет кошельками, подписками, сагами (block/capture/release), реферальной системой и интеграцией с [Lago](https://www.getlago.com/).

---

## Стек

| Слой | Технология |
|---|---|
| Runtime | Node.js 20, NestJS 10 |
| БД | PostgreSQL + Prisma ORM |
| Кэш / Идемпотентность | Redis (ioredis) |
| Очереди | Kafka (KafkaJS) |
| Биллинг | Lago (lago-javascript-client) |
| Метрики | Prometheus (prom-client) |
| Авторизация | JWT (passport-jwt) + Internal API Key |

---

## Требования

- Node.js ≥ 20
- npm ≥ 10
- PostgreSQL
- Redis
- Kafka
- Экземпляр Lago (self-hosted или cloud)

---

## Установка

```bash
npm install
```

---

## Переменные окружения

Скопируйте `.env.example` и заполните значения:

```bash
cp .env.example .env
```

Основные переменные:

| Переменная | Описание |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `LAGO_API_URL` | URL инстанса Lago |
| `LAGO_API_KEY` | API-ключ Lago |
| `JWT_SECRET` | Секрет для проверки JWT |
| `INTERNAL_API_KEY` | Ключ для межсервисных запросов |
| `KAFKA_BROKERS` | Список брокеров Kafka (через запятую) |

---

## Миграции БД

```bash
# Применить все миграции
npx prisma migrate deploy

# Сгенерировать Prisma Client
npx prisma generate
```

---

## Запуск

```bash
# Режим разработки (watch)
npm run start:dev

# Обычный запуск
npm run start

# Продакшн
npm run start:prod
```

---

## Тесты

```bash
# Unit-тесты
npm run test

# Unit-тесты в watch-режиме
npm run test:watch

# E2E-тесты
npm run test:e2e

# Покрытие
npm run test:cov
```

---

## API

Swagger UI доступен по адресу `/api/docs` после запуска сервиса.

### Публичные эндпоинты (требуют JWT)

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/billing/balance` | Баланс кошелька |
| `GET` | `/api/billing/subscription` | Текущая подписка |
| `POST` | `/api/billing/topup` | Пополнение кошелька |
| `GET` | `/api/billing/quote` | Расчёт стоимости |

### Внутренние эндпоинты (требуют `X-Internal-Api-Key`)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/internal/billing/quote` | Расчёт стоимости (Bulk Service) |
| `POST` | `/api/internal/billing/block` | Резервирование средств (Saga Phase 1) |
| `POST` | `/api/internal/billing/capture` | Подтверждение списания |
| `POST` | `/api/internal/billing/release` | Отмена резервирования |
| `POST` | `/api/internal/billing/block-batch` | Пакетное резервирование |
| `POST` | `/api/internal/billing/waived/check` | Проверка бесплатных генераций |

### Административные эндпоинты (требуют JWT + роль Admin)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/admin/billing/subscription-plan` | Управление тарифными планами |
| `POST` | `/api/admin/billing/volume-discount` | Управление объёмными скидками |

---

## Структура проекта

```
src/
├── billing/          # Основная бизнес-логика биллинга
│   ├── dto/          # DTO запросов
│   ├── saga.service  # Saga (block / capture / release)
│   ├── quote.service # Расчёт стоимости
│   └── waived.service# Бесплатные генерации
├── background/       # Cron-задачи (expired subscriptions, etc.)
├── kafka/            # Kafka consumers / producers
├── product/          # Справочник продуктов
└── shared/           # Guards, interceptors, utils, Lago/Redis/Prisma services
```

---

## Лицензия

UNLICENSED — проприетарный код.
