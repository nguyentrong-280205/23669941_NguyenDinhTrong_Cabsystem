# CAB System – Microservices Architecture

Runtime đã được cập nhật ngày 01/10/2026. Hướng dẫn chạy: [docs/operations.md](docs/operations.md). Thay đổi và bằng chứng kiểm tra: [docs/reports/fixes.md](docs/reports/fixes.md). Các phần mục tiêu nghiệm thu bên dưới không đồng nghĩa đã kiểm thử tải/HA hoặc tích hợp provider thật.

API hiện hành dùng `/api/v1`. Xem [quy ước và các endpoint REST v1](docs/rest_api_v1.md), gồm payload mới cho nhận/từ chối Offer và hủy Booking.

## 1. Giới thiệu

CAB System là hệ thống đặt xe trực tuyến được thiết kế theo kiến trúc **Microservices**.  
Thiết kế trong repository này bám theo `docs/requirements/srs.md` và `docs/architecture/microservice_design.md`.

Phiên bản MVP gồm:

- **7 microservice nghiệp vụ**
  - Identity
  - Customer
  - Driver
  - Booking
  - Trip
  - Payment
  - Notification
- **1 API Gateway**
- **4 thành phần hạ tầng chính**
  - PostgreSQL
  - MongoDB replica set
  - Apache Kafka
  - Redis

Client chỉ truy cập hệ thống thông qua **Gateway**. Các service không được đọc/ghi trực tiếp database của service khác.

---

# 2. Kiến trúc tổng thể

```text
                         CLIENT / POSTMAN
                                │
                                │ HTTP/REST
                                ▼
                        ┌───────────────┐
                        │    Gateway    │
                        │               │
                        │ JWT / RBAC    │
                        │ Rate Limit    │
                        │ Routing       │
                        │ Health        │
                        └───────┬───────┘
                                │
            ┌───────────────────┼─────────────────────────────┐
            │                   │                             │
            ▼                   ▼                             ▼
       Identity             Customer                      Driver
            │                   │                             │
            ▼                   ▼                             ▼
      identity_db          customer_db                   driver_db

            ┌───────────────────┼─────────────────────────────┐
            │                   │                             │
            ▼                   ▼                             ▼
         Booking               Trip                        Payment
            │                   │                             │
            ▼                   ▼                             ▼
       booking_db            trip_db                    payment_db

                                │
                                ▼
                         Notification
                                │
                                ▼
                        notification_db


                    ┌──────────────────────┐
                    │        Kafka         │
                    │ Domain Events / IPC  │
                    └──────────────────────┘

                    ┌──────────────────────┐
                    │        Redis         │
                    │ Shared Rate Limiting │
                    └──────────────────────┘
```

---

# 3. Nguyên tắc kiến trúc

1. Mỗi service sở hữu database/schema riêng.
2. Không có foreign key xuyên database.
3. Không service nào được đọc/ghi trực tiếp database của service khác.
4. Transaction chỉ đảm bảo trong phạm vi database cục bộ.
5. Giao tiếp liên service cần kết quả ngay dùng **HTTP nội bộ**.
6. Giao tiếp bất đồng bộ dùng **Kafka**.
7. Client và callback từ hệ thống ngoài đều đi qua Gateway.
8. IPC nội bộ không đi vòng qua Gateway.
9. Dùng idempotency, outbox/inbox, retry và cơ chế bù/đối soát khi cần.
10. Kafka không được xem là cơ chế bảo đảm "exactly once" cho database hoặc provider bên ngoài.

---

# 4. Cấu trúc repository

```text
CAB-System/
├── services/
│   ├── gateway/src/                   # Cùng các tầng bên dưới; repository dùng Redis
│   └── {identity,customer,driver,booking,trip,payment,notification}/
│       ├── src/
│       │   ├── config/index.js         # Cấu hình và kiểm tra env của owner
│       │   ├── routes/*.routes.js     # Endpoint, action, quyền gọi IPC
│       │   ├── controllers/*.controller.js # Request/response HTTP
│       │   ├── services/*.service.js  # Nghiệp vụ, workflow, event handler
│       │   ├── repositories/*.repository.js # Truy cập persistence của owner
│       │   ├── models/index.js        # Chỉ 4 MongoDB owner
│       │   ├── index.js               # Ghép các tầng và dependency
│       │   ├── app.js                 # Tạo Express app
│       │   └── server.js              # Khởi động tiến trình
│       ├── migrations/002_records.sql  # 3 PostgreSQL owner
│       ├── Dockerfile
│       └── .env.example
├── shared/lib/                        # HTTP, storage, security, contracts, events
├── infra/                             # Compose, PostgreSQL/MongoDB/Kafka bootstrap
├── scripts/                           # configure, start, seed, sandbox, smoke
├── tests/                             # HTTP regression, recovery, persistence double
├── docs/
│   ├── requirements/srs.md
│   ├── architecture/microservice_design.md
│   ├── api_document/                  # owner contracts và Gateway sinh tự động
│   ├── reports/                       # review và kết quả sửa
│   ├── legacy-source/                 # tham khảo .txt, không chạy
│   └── operations.md
├── package.json                       # npm workspaces
├── compose.yaml                       # Chạy Docker Compose từ root
├── package-lock.json                  # lockfile chuẩn
├── .env.example
└── README.md
```

Luồng request: `routes → controllers → services → repositories → database`. `src/index.js` ghép các tầng; `app.js` tạo HTTP app, `server.js` khởi động cấu hình/DB/Kafka và worker. `shared/lib` cung cấp cơ chế hạ tầng dùng chung, không chứa nghiệp vụ của owner. Xem [hướng dẫn đọc source](docs/architecture/source_structure.md) để theo dõi một API cụ thể.

---

# 5. Các service chính

## 5.1 Gateway

Gateway là entry point duy nhất của client.

### Trách nhiệm

- Route request theo method/path.
- Xác thực JWT.
- Kiểm tra role/quyền ở mức route.
- Rate limiting qua Redis.
- Giới hạn request body và content type.
- CORS.
- Sinh và truyền `correlationId`.
- Tổng hợp health/readiness của hệ thống.
- Loại bỏ các header danh tính/quyền do client tự giả mạo.

Gateway **không xử lý nghiệp vụ** như:

- tạo Booking,
- matching Driver,
- tính Fare,
- quyết định Payment thành công.

### Route chính

| Route | Service đích |
|---|---|
| `POST /api/v1/customers/register, POST /api/v1/drivers/register, POST /api/v1/customers/login, POST /api/v1/drivers/login, POST /api/v1/admin/login, /api/v1/driver-otp-*` | Identity |
| `GET /api/v1/customers/{id}` | Customer |
| `/api/v1/drivers/*` | Driver |
| `/api/v1/bookings`, `/api/v1/bookings/*`, `/api/v1/booking-offers/*` | Booking |
| `/api/v1/trips/*` | Trip |
| `/api/v1/payments*` | Payment |
| `/api/v1/notifications*` | Notification |
| `/api/v1/health`, `/api/v1/ready`, `/api/v1/health/services` | Gateway |

---

# 6. Identity Service

Identity Service sở hữu:

- User
- Role
- Credential
- OTP Challenge
- Registration Workflow

### API chính

```text
POST /api/v1/customers/register
POST /api/v1/customers/login
POST /api/v1/drivers/login
POST /api/v1/admin/login
POST /api/v1/driver-otp-challenges
POST /api/v1/driver-otp-verifications
POST /api/v1/drivers/register
```

### Database

```text
PostgreSQL → identity_db
```

Identity Service có migration riêng.

### Aggregate chính

```text
Role
User
OtpChallenge
RegistrationWorkflow
```

### Trách nhiệm

- Đăng ký Customer.
- Đăng ký Driver.
- OTP.
- Login/JWT.
- Role và trạng thái truy cập.
- Hash password có salt.
- Điều phối tạo profile Customer/Driver bằng workflow idempotent.

---

# 7. Customer Service

Customer Service sở hữu hồ sơ Customer.

### Database

```text
MongoDB → customer_db
```

Customer Service không dùng migration SQL; schema/model được quản lý bằng MongoDB model.

### Dữ liệu chính

```text
Customer
├── customerId
├── userId
├── registrationId
├── defaultPaymentMethod
├── createdAt
└── updatedAt
```

`userId` chỉ là tham chiếu ngoài tới Identity, không phải foreign key xuyên database.

Customer không lưu:

- password,
- OTP,
- credential,
- bản sao User làm nguồn dữ liệu thứ hai.

### API / trách nhiệm

- Lấy hồ sơ Customer.
- Quản lý `defaultPaymentMethod`.
- Tạo hồ sơ Customer từ registration workflow của Identity.
- Kiểm tra ownership.

---

# 8. Driver Service

Driver Service sở hữu:

- Driver
- Vehicle
- VehicleType
- DriverLocation
- DriverReservation
- Xét duyệt Driver
- Availability

### Database

```text
MongoDB → driver_db
```

Driver Service không dùng migration SQL; schema/model được quản lý bằng MongoDB model.

### API chính

```text
GET /api/v1/drivers/{id}
GET /api/v1/drivers
PATCH /api/v1/drivers/me
GET /api/v1/driver-applications
PATCH /api/v1/driver-applications/{id}
```

### Trạng thái chính

```text
approvalStatus:
PENDING → APPROVED / REJECTED

availabilityStatus:
OFFLINE ↔ AVAILABLE
AVAILABLE → BUSY
```

Driver chỉ được matching khi phù hợp các điều kiện như:

- APPROVED
- AVAILABLE
- VehicleType phù hợp
- Location hợp lệ

---

# 9. Booking Service

Booking Service sở hữu:

- Booking
- DriverOffer
- Matching/Dispatch
- Assignment workflow
- Cancellation workflow

### Database

```text
PostgreSQL → booking_db
```

Booking Service có migration riêng.

### API chính

```text
POST /api/v1/bookings
GET /api/v1/bookings?customerId={id}
GET /api/v1/booking-offers
PATCH /api/v1/booking-offers/{id}
PATCH /api/v1/bookings/{id}
```

### Booking state

```text
CREATED
   ↓
SEARCHING_DRIVER
   ├──→ DRIVER_ASSIGNED → CONFIRMED → COMPLETED
   ├──→ NO_DRIVER_FOUND
   └──→ CANCELED
```

### DriverOffer state

```text
PENDING
├── ACCEPTED
├── REJECTED
├── TIMEOUT
└── CANCELED
```

Matching sử dụng Driver Service để tìm Driver phù hợp, không đọc `driver_db` trực tiếp.

---

# 10. Trip Service

Trip Service sở hữu:

- Trip lifecycle
- Tracking orchestration
- PricingRule
- Fare
- Rating
- Projection `paymentStatus`

### Database

```text
MongoDB → trip_db
```

Trip Service không dùng migration SQL; schema/model được quản lý bằng MongoDB model.

### API chính

```text
PATCH /api/v1/trips/{id}
POST /api/v1/trips/{id}/locations
GET /api/v1/trips/{id}
POST /api/v1/trips/{id}/reviews
```

### Trip state

```text
ASSIGNED
   ↓
DRIVER_ARRIVING
   ↓
DRIVER_ARRIVED
   ↓
PICKED_UP
   ↓
IN_PROGRESS
   ↓
COMPLETED
```

Hủy chỉ được thực hiện trước `PICKED_UP` theo rule hiện tại.

### Fare

Fare chỉ được tính khi Trip hoàn thành và có dữ liệu:

- distanceKm
- durationMinutes
- PricingRule hợp lệ

Trip Service là owner của Fare. Payment Service không được tự tính Fare.

---

# 11. Payment Service

Payment Service sở hữu:

- Payment
- PaymentAttempt
- CallbackReceipt
- Idempotency
- Reconciliation

### Database

```text
PostgreSQL → payment_db
```

Payment Service có migration riêng.

### API chính

```text
POST /api/v1/payments
POST /api/v1/payment-callbacks
GET /api/v1/payments/{id}
```

### Payment state

```text
PENDING
   ↓
PROCESSING
   ├──→ COMPLETED
   └──→ FAILED
```

Payment Service phải:

- lấy Fare từ Trip Service,
- không tin `amount` do client tự gửi,
- xác minh callback,
- chống charge trùng,
- dùng `Idempotency-Key`.

---

# 12. Notification Service

Notification Service sở hữu:

- Notification
- Delivery task
- Retry
- Provider delivery status

### Database

```text
MongoDB → notification_db
```

Notification Service không dùng migration SQL; schema/model được quản lý bằng MongoDB model.

### Nguồn event

Notification nhận sự kiện từ Kafka để gửi:

- Booking notification
- Driver Offer
- Driver assigned
- Driver arrived
- Trip completed/canceled
- Payment result
- NO_DRIVER_FOUND
- OTP
- Driver application result

### Trạng thái delivery

```text
PENDING
   ↓
PROCESSING
   ↓
SENT
   ├──→ DELIVERED
   └──→ FAILED
```

Notification lỗi không rollback nghiệp vụ nguồn.

---

# 13. Database per Service

CAB System sử dụng **Polyglot Persistence**: một số service dùng PostgreSQL, các service còn lại dùng MongoDB theo phân chia đã chốt.

## 13.1 PostgreSQL

Các service sử dụng PostgreSQL:

```text
Identity Service  → identity_db
Booking Service   → booking_db
Payment Service   → payment_db
```

Các service này phù hợp với dữ liệu cần quan hệ chặt chẽ, transaction và constraint rõ ràng.

Cấu trúc:

```text
PostgreSQL
├── identity_db
├── booking_db
└── payment_db
```

Mỗi service:

- sở hữu database/schema riêng,
- dùng tài khoản truy cập riêng,
- có migration riêng,
- không truy cập trực tiếp database của service khác.

## 13.2 MongoDB

Các service sử dụng MongoDB:

```text
Customer Service      → customer_db
Driver Service        → driver_db
Trip Service          → trip_db
Notification Service  → notification_db
```

Cấu trúc:

```text
MongoDB
├── customer_db
├── driver_db
├── trip_db
└── notification_db
```

Các service dùng MongoDB quản lý schema/model ở tầng application/model thay vì migration SQL.

## 13.3 Gateway

Gateway không sở hữu database nghiệp vụ.

Gateway sử dụng:

```text
Redis → shared rate limiting
```

## 13.4 Quy tắc ownership

```text
Identity      → PostgreSQL
Booking       → PostgreSQL
Payment       → PostgreSQL

Customer      → MongoDB
Driver        → MongoDB
Trip          → MongoDB
Notification  → MongoDB

Gateway       → Redis
Kafka         → Message Broker
```

Quy tắc:

1. Mỗi service chỉ đọc/ghi database của mình.
2. Không có cross-database foreign key.
3. Không join trực tiếp dữ liệu giữa database của các service.
4. Liên service giao tiếp qua HTTP nội bộ hoặc Kafka.
5. PostgreSQL service dùng migration.
6. MongoDB service dùng model/schema riêng.

---

# 14. Kafka

Kafka là message broker cho giao tiếp bất đồng bộ và domain events.

## 14.1 Kafka topics

| Topic | Producer / Event chính | Partition Key | Consumer Group chính |
|---|---|---|---|
| `cab.booking.events` | Booking: `booking.created`, `offer.created`, `booking.canceled`, `booking.no-driver-found` | `bookingId` | `booking.matching`, `notification.events` |
| `cab.trip.events` | Trip: `driver.assigned`, `driver.arrived`, `trip.canceled`, `trip.completed` | `tripId` | `booking.trip-status`, `driver.trip-status`, `notification.events` |
| `cab.payment.events` | Payment: `payment.completed`, `payment.failed`, `payment.processing` | `tripId` | `trip.payment-status`, `notification.events` |
| `cab.driver.events` | Driver: `driver.application.reviewed` | `driverId` | `notification.events` |
| `cab.identity.otp` | Identity: `otp.requested` | `challengeId` | `notification.otp` |

## 14.2 Event envelope

Event nên có tối thiểu:

```json
{
  "eventId": "uuid",
  "eventType": "trip.completed",
  "version": 1,
  "aggregateId": "uuid",
  "aggregateVersion": 3,
  "occurredAt": "2026-01-01T00:00:00Z",
  "correlationId": "uuid",
  "payload": {}
}
```

## 14.3 Producer

Producer đề xuất:

```text
acks=all
enable.idempotence=true
```

Service ghi **outbox** cùng transaction nghiệp vụ rồi worker phát event tới Kafka.

## 14.4 Consumer

Consumer:

- tắt auto commit,
- dùng inbox dedup theo `eventId`,
- commit DB trước,
- sau đó mới commit Kafka offset,
- xử lý tuần tự theo partition khi cần giữ thứ tự.

## 14.5 Retry và DLT

Đề xuất MVP:

```text
Retry:
1s → 2s → 4s → 8s → 16s
```

Sau khi hết retry:

```text
<source-topic>.<consumer-group>.dlt
```

DLT giữ các thông tin:

- eventId
- topic
- partition
- offset
- attempts
- lỗi đã mask

## 14.6 Retention

Đề xuất:

```text
Domain topic: 7 ngày
DLT:          14 ngày
OTP topic:    khoảng 1 giờ
```

OTP vẫn phải kiểm tra `expiresAt`; retention Kafka không thay TTL nghiệp vụ.

---

# 15. Kiểm tra hệ thống Kafka

Kafka là thành phần bắt buộc cần kiểm chứng trong bài.

## Kiểm tra cơ bản

```text
1. Kafka container chạy.
2. Kafka broker sẵn sàng.
3. Topic được tạo.
4. Producer publish event thành công.
5. Consumer đúng group nhận event.
6. Offset được commit đúng.
7. Consumer restart không gây xử lý trùng tác dụng.
8. Event trùng bị inbox dedup.
9. Event lỗi được retry.
10. Hết retry được đưa vào DLT.
11. Consumer lag có thể quan sát.
12. Kafka restart vẫn giữ dữ liệu nếu volume hoạt động.
```

## Luồng test

```text
Service
   │
   │ Outbox
   ▼
Producer
   │
   ▼
Kafka Topic
   │
   ▼
Consumer Group
   │
   ├── Inbox / Dedup
   ├── Business Update
   └── Commit Offset
```

## Kafka MVP

Môi trường demo dùng:

```text
Kafka KRaft
1 broker/controller
replication.factor=1
min.insync.replicas=1
```

Cấu hình này phục vụ demo, **không có High Availability**.

---

# 16. Redis

Redis dùng cho **shared rate limiting** tại Gateway.

Ví dụ rule quan trọng:

```text
POST /api/v1/bookings:
30 request/phút/user
120 request/phút/IP
```

Nếu vượt giới hạn:

```text
HTTP 429 Too Many Requests
Retry-After: ...
```

Redis không phải database nghiệp vụ.

---

# 17. HTTP nội bộ

Các service dùng HTTP nội bộ khi cần kết quả ngay.

Ví dụ:

```text
Identity → Customer
POST /api/v1/internal-customer-registrations

Identity → Driver
POST /api/v1/internal-driver-registrations

Booking → Customer
GET /api/v1/internal-customers/{id}

Booking → Driver
GET /api/v1/internal-drivers

Booking → Trip
POST /api/v1/internal-trips

Trip → Driver
POST /api/v1/internal-drivers/{id}/locations

Payment → Trip
GET /api/v1/internal-trips/{id}/payment-contexts

Notification → Booking
GET /api/v1/internal-offers/{id}/delivery-contexts
```

Các route `/api/v1/internal-*`:

- chỉ mở trong internal network,
- không public qua Gateway,
- cần service authentication,
- truyền `correlationId`,
- mutation phải có idempotency khi cần.

---

# 18. Luồng đặt xe End-to-End

```text
Customer
   │
   ▼
Gateway
   │
   ▼
Identity
   │
   └── Login → JWT

Customer
   │ POST /api/v1/bookings
   ▼
Gateway
   ▼
Booking
   │
   ├── Booking SEARCHING_DRIVER
   └── outbox booking.created
          │
          ▼
        Kafka
          │
          ▼
 booking.matching consumer
          │
          ▼
       Booking
          │
          ▼
        Driver
     Find candidate
          │
          ▼
     DriverOffer
          │
          ▼
        Kafka
          │
          ▼
    Notification
          │
          ▼
        Driver

Driver accept
   │
   ▼
Gateway
   ▼
Booking
   ├── Reserve Driver
   ├── Create Trip
   ├── Confirm Driver BUSY
   ├── Booking DRIVER_ASSIGNED
   └── Activate Trip
```

---

# 19. Luồng Trip hoàn thành

```text
Driver
   │ PATCH status / POST location
   ▼
Gateway
   ▼
Trip
   │
   ├── kiểm tra state
   ├── kiểm tra ownership
   └── lưu location qua Driver Service

Trip COMPLETED
   │
   ├── tính Fare
   └── publish trip.completed
             │
             ▼
           Kafka
        ┌────┼─────┐
        ▼    ▼     ▼
     Booking Driver Notification
```

Booking đồng bộ `COMPLETED`, Driver được release đúng assignment, Notification gửi thông báo hoàn thành.

---

# 20. Luồng Payment

```text
Customer
   │
   │ POST /api/v1/payments
   ▼
Gateway
   ▼
Payment
   │
   ├── gọi Trip lấy Fare/ownership
   ├── lưu Payment + idempotency
   └── gọi Payment Provider
             │
             ▼
        PROCESSING

Payment Provider
   │ callback
   ▼
Gateway
   ▼
Payment
   │
   ├── verify signature
   ├── dedup callback
   ├── COMPLETED
   └── outbox
          │
          ▼
        Kafka
          │
          ├── Trip → paymentStatus PAID
          └── Notification
```

---

# 21. Docker / Container

MVP có:

## Application containers

```text
gateway
identity-service
customer-service
driver-service
booking-service
trip-service
payment-service
notification-service
```

## Infrastructure containers

```text
postgres
mongodb
kafka
redis
```

Tổng cộng:

```text
8 application containers
4 infrastructure containers
```

Host chỉ public Gateway.

Các service nghiệp vụ, PostgreSQL, Kafka và Redis chỉ hoạt động trong internal network.

---

# 22. Health & Readiness

Gateway cung cấp:

```text
GET /api/v1/health
GET /api/v1/ready
GET /api/v1/health/services
```

| Endpoint | Auth | Ý nghĩa |
|---|---|---|
| `/api/v1/health` | Public | Process Gateway còn sống |
| `/api/v1/ready` | Public | Dependency bắt buộc sẵn sàng |
| `/api/v1/health/services` | Admin JWT | Tổng hợp trạng thái các service |

Kết quả degraded/unavailable phù hợp có thể trả `503`.

---

# 23. Security

Các yêu cầu chính:

- JWT verify:
  - signature
  - algorithm
  - expiration
  - issuer
  - audience
- Sai token → `401`
- Sai role/quyền → `403`
- Ownership được owner service kiểm tra.
- Password hash có salt.
- Driver license lưu dạng ciphertext + fingerprint.
- Không log:
  - password
  - OTP plaintext
  - token
  - CVV
  - full card secret
- Query phải parameterized.
- Audit log phải mask dữ liệu nhạy cảm.

---

# 24. Audit & Reporting

Mỗi service có thể có:

```text
AuditLog
Outbox
Inbox
```

AuditLog append-only có thể gồm:

```text
actorUserId
action
targetType
targetId
beforeData
afterData
ipAddress
correlationId
createdAt
```

Reporting không được join trực tiếp database nhiều service. Reporting dùng:

- API owner,
- projection model,
- dữ liệu có freshness rõ ràng.

---

# 25. Claude Code và 3 Custom SubAgent

Repository sử dụng:

```text
.claude/
└── agents/
    ├── ba-agent.md
    ├── dev-agent.md
    └── test-agent.md
```

## BA Agent

BA Agent:

- đọc `srs.md`,
- đọc `microservice_design.md`,
- xác định FR/UC/BP,
- kiểm tra service ownership,
- chuẩn hóa API document,
- phát hiện yêu cầu chưa rõ,
- không tự ý thay đổi business rule.

## Dev Agent

Dev Agent:

- đọc tài liệu BA,
- triển khai đúng boundary service,
- tạo migration riêng cho từng service,
- implement internal HTTP,
- implement Kafka producer/consumer,
- implement outbox/inbox,
- implement Redis rate limit,
- implement Docker Compose,
- không tạo cross-DB query.

## Test Agent

Test Agent:

- test REST API qua Gateway,
- test internal integration,
- test JWT/RBAC,
- test state transition,
- test idempotency,
- test Kafka:
  - producer,
  - consumer group,
  - offset,
  - duplicate,
  - retry,
  - DLT,
  - lag,
- test Redis rate limit,
- tạo test report.

---

# 26. Workflow Claude Code

```text
             SRS
              │
              ▼
        ┌────────────┐
        │  BA Agent  │
        └──────┬─────┘
               │
               ▼
     Requirements / Design
        API Documentation
               │
               ▼
        ┌────────────┐
        │ Dev Agent  │
        └──────┬─────┘
               │
               ▼
       Services / DB / IPC
       Kafka / Redis / Docker
               │
               ▼
        ┌────────────┐
        │ Test Agent │
        └──────┬─────┘
               │
               ▼
        API / E2E / Kafka
        Security / Performance
             Reports
```

---

# 27. Thứ tự triển khai đề xuất

```text
1. Chuẩn hóa SRS
2. Chuẩn hóa microservice_design.md
3. Hoàn thiện API document
4. Tạo Gateway
5. Tạo Identity
6. Tạo Customer
7. Tạo Driver
8. Tạo Booking
9. Tạo Trip
10. Tạo Payment
11. Tạo Notification
12. Tạo 3 PostgreSQL DB: identity_db, booking_db, payment_db
13. Tạo 4 MongoDB DB: customer_db, driver_db, trip_db, notification_db
14. Tạo migration cho Identity/Booking/Payment
15. Tạo MongoDB model/schema cho Customer/Driver/Trip/Notification
16. Implement internal HTTP
17. Cấu hình Redis
18. Cấu hình Kafka KRaft
19. Tạo Kafka topics
20. Implement Outbox/Inbox
21. Implement Producer/Consumer
22. Docker Compose
23. Seed dữ liệu demo
24. Postman API Test
25. Kafka Test
26. RBAC/Security Test
27. E2E Test
28. Performance Test
29. Test Report
```

---

# 28. Kiểm thử chính

## API

- Register Customer.
- Login.
- OTP Driver.
- Register Driver.
- Driver approval.
- Driver availability.
- Create Booking.
- Matching.
- Offer accept.
- Trip lifecycle.
- Location update.
- Cancel.
- Payment.
- Notification.
- Rating.

## Kafka

- Topic tồn tại.
- Producer publish.
- Consumer nhận.
- Consumer group đúng.
- Commit offset đúng.
- Duplicate event không tạo tác dụng trùng.
- Retry hoạt động.
- DLT hoạt động.
- Consumer restart.
- Kafka restart.
- Consumer lag.
- Outbox backlog.

## Security

- JWT sửa → 401.
- Sai role → 403.
- Ownership.
- Injection.
- XSS rendering.
- Secret masking.

## Performance

- API p95 mục tiêu ≤ 2 giây.
- Search/rank mục tiêu ≤ 3 giây.
- Location update chu kỳ 5–10 giây.
- Report mục tiêu ≤ 5 giây.
- Rate limit vẫn hoạt động khi tải cao.

---

# 29. Dữ liệu demo

Dữ liệu seed hiện có, toàn bộ tài khoản/ID/trạng thái và cách dùng từng kịch bản: [docs/demo_data.md](docs/demo_data.md).

Demo nên có tối thiểu:

```text
Customer A
Customer B

>= 6 Driver
├── AVAILABLE
├── BUSY
├── OFFLINE
├── SUSPENDED
├── trong bán kính
└── ngoài bán kính

>= 2 hồ sơ Driver PENDING

>= 5 Booking của Customer A
>= 1 Booking của Customer B

Trip hoàn thành
Trip bị hủy
Trip dùng test hủy muộn

Fare
Payment sandbox
Rating
Notification
```

---

# 30. Mục tiêu nghiệm thu

Hệ thống được xem là đạt kiến trúc MVP khi chứng minh được:

```text
Client
   │
   ▼
Gateway
   │
   ├── Identity
   ├── Customer
   ├── Driver
   ├── Booking
   ├── Trip
   ├── Payment
   └── Notification

Mỗi service
   │
   ▼
database riêng theo service

Async IPC
   │
   ▼
Kafka

Rate Limit
   │
   ▼
Redis
```

Checklist:

- 7 microservice nghiệp vụ hoạt động.
- Gateway hoạt động.
- 3 PostgreSQL database + 4 MongoDB database tách biệt.
- Không cross-DB access.
- Internal HTTP hoạt động.
- Kafka hoạt động.
- Kafka topic/event đúng thiết kế.
- Producer/consumer hoạt động.
- Offset và consumer group hoạt động.
- Retry/DLT hoạt động.
- Redis rate limit hoạt động.
- JWT/RBAC hoạt động.
- End-to-End booking/trip/payment hoạt động.
- Health/readiness hoạt động.
- BA Agent, Dev Agent và Test Agent có vai trò rõ ràng.

---

# 31. Kết luận

CAB System MVP sử dụng kiến trúc:

```text
External communication:
Client → Gateway → REST/HTTP

Synchronous internal IPC:
Service → Service → HTTP nội bộ

Asynchronous IPC:
Service → Kafka → Service

Business databases:
Identity      → identity_db
Customer      → customer_db
Driver        → driver_db
Booking       → booking_db
Trip          → trip_db
Payment       → payment_db
Notification  → notification_db

Shared infrastructure:
PostgreSQL
MongoDB
Kafka
Redis

Development workflow:
BA Agent → Dev Agent → Test Agent
```

Thiết kế này giữ đúng ranh giới service, database ownership, giao tiếp HTTP/Kafka và các yêu cầu hạ tầng của CAB System.

### Lu?ng nghi?p v? kh?ng gi?i h?n th?i gian

OTP, token ??ng nh?p v? token ??ng k? kh?ng h?t h?n; y?u c?u OTP kh?ng c?n ch?. OTP v?n ch? d?ng m?t l?n v? kh?a sau 5 l?n sai. Offer ch? ??n khi t?i x? nh?n/t? ch?i ho?c kh?ch h?y; t?m t?i x? kh?ng c? gi?i h?n 3 ph?t. V? tr? ???c c?p nh?t theo th? t? nh?n, kh?ng b? lo?i do c? ho?c kh?c gi? m?y; m?u tr?ng kh?ng c?ng l?i qu?ng ???ng. Gi? d?ng phi?n b?n cao nh?t, kh?ng ch? effectiveFrom; c??c g?m gi? m? c?a v? qu?ng ???ng, timeFare/durationMinutes b?ng 0. expiresAt/expiresIn tr? null. Gateway kh?ng gi?i h?n s? y?u c?u theo ph?t; th?ng b?o l?i ???c th? l?i ? l??t x? l? ti?p theo. D?u th?i gian l?ch s?, timeout k?t n?i v? c? ch? ph?c h?i worker v?n ???c gi?.
