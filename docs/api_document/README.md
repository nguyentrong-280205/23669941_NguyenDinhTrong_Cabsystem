# CAB System – API theo microservice

Bộ hợp đồng API theo kiến trúc **Identity, Customer, Driver, Booking, Trip, Payment, Notification** và **Gateway**. Nguồn yêu cầu: [SRS mục X](../requirements/srs.md#x--hợp-đồng-api-phục-vụ-chấm); quyền sở hữu và IPC theo [thiết kế microservice](../architecture/microservice_design.md).

Đây là bộ hợp đồng hiện hành tại `docs/api_document/`, chưa xác nhận API/backend hoạt động. Bộ YAML cũ đã được bỏ khỏi cấu trúc hiện tại; lịch sử chuyển đổi và phần mở rộng cần đặc tả được ghi trong MIGRATION.md. Identity/Booking/Payment dùng PostgreSQL; Customer/Driver/Trip/Notification dùng MongoDB theo SRS, thể hiện bằng metadata `x-persistence` tại file owner. Chuyển DB không đổi path hoặc ID của API.

## 1. Cấu trúc

```text
api_document/
├── README.md
├── MIGRATION.md                  # Khác biệt và phân công lại API cũ
├── gateway/
│   ├── README.md
│   ├── health.json               # Nguồn 3 endpoint health của Gateway
│   └── openapi.json              # Tổng hợp API qua Gateway + health
├── identity/
│   ├── README.md
│   ├── openapi.json              # Đăng ký Customer/Driver, login, OTP
│   └── internal.json             # User profile, cập nhật/khóa User
├── customer/
│   ├── README.md
│   ├── openapi.json              # GET Customer
│   └── internal.json             # Tạo/tra cứu hồ sơ, xác minh Customer/userId
├── driver/
│   ├── README.md
│   ├── openapi.json              # Driver, nearby, availability, xét duyệt
│   └── internal.json             # Đăng ký, matching candidate, reservation, vị trí
├── booking/
│   ├── README.md
│   ├── openapi.json              # Booking, Offer, accept/rejections, hủy
│   └── internal.json             # Offer delivery context cho Notification
├── trip/
│   ├── README.md
│   ├── openapi.json              # Trip/status/locations/reviews, Fare
│   └── internal.json             # Tạo/tra cứu/activate/cancellations, payment-context
├── payment/
│   ├── README.md
│   └── openapi.json              # Payment, callback, idempotency
├── notification/
│   ├── README.md
│   └── openapi.json              # Danh sách thông báo theo người nhận
├── kafka/
│   ├── README.md
│   ├── topics.json               # Producer, partition key, group, eventType
│   ├── event-envelope.schema.json
│   ├── identity.events.schema.json
│   ├── booking.events.schema.json
│   ├── driver.events.schema.json
│   ├── trip.events.schema.json
│   ├── payment.events.schema.json
│   └── examples/
│       └── payment.completed.json
└── scripts/
    ├── sync-gateway.cjs          # Sinh Gateway từ 7 file owner và health.json
    ├── validate.cjs              # Cấu trúc, refs, độ phủ SRS và đồng bộ owner
    └── validate-specs.cjs        # OpenAPI validator + JSON Schema + boundary cases
```

## 2. Cách sử dụng

- Để xem hoặc import toàn bộ API client, mở [gateway/openapi.json](gateway/openapi.json) bằng công cụ hỗ trợ OpenAPI, ví dụ Swagger Editor hoặc Postman.
- Để làm một service, mở `openapi.json` trong thư mục service tương ứng. Mỗi file chứa đủ schema, không cần resolve file schema ngoài.
- `internal.json` dùng riêng cho giao tiếp service-to-service; không đưa vào route Gateway hoặc collection API client. Port mặc định khớp Compose hiện tại: Identity 3001, Customer 3002, Driver 3003, Booking 3004, Trip 3005, Payment 3006, Notification 3007; thay biến port khi môi trường thay đổi.
- Hợp đồng HTTP dùng [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html), định dạng JSON. Kafka dùng JSON Schema riêng, không mô tả event bằng endpoint HTTP giả.

Origin client mặc định là `http://localhost:8080`. Mọi endpoint dùng prefix `/api/v1`, ví dụ `http://localhost:8080/api/v1/bookings`. OpenAPI đã chứa prefix trong `paths`, nên không thêm prefix lần nữa vào `servers.url`. Xem [quy ước REST v1](../rest_api_v1.md).

## 3. Phạm vi hợp đồng

Các file bao phủ toàn bộ endpoint nghiệm thu tại SRS 10.2 và ba API health. Nhận/từ chối Offer dùng chung `PATCH /api/v1/booking-offers/{id}` với body `status: ACCEPTED/REJECTED`. `GET /api/v1/trips/{id}/fares` được đánh dấu `x-contract: extension`.

`internal.json` cụ thể hóa danh mục IPC trong thiết kế mục 10.1 và có `x-contract: internal-proposal`. Những lựa chọn chưa chốt như port, header chữ ký provider, service JWT và cách chuyển actor token đều được ghi là đề xuất, cần thống nhất khi code.

API quản trị/Should chưa có hợp đồng tương ứng ở SRS X được ghi trong [MIGRATION.md](MIGRATION.md) để tiếp tục đặc tả theo đúng owner. Bộ này đầy đủ cho danh mục nghiệm thu SRS 10.2; chưa bao phủ mọi route quản trị mở rộng của FR01–FR80.

## 4. Quy ước chung

| Nội dung | Quy ước |
|---|---|
| Owner | `x-service-owner` là service thực thi; Gateway không sở hữu nghiệp vụ |
| Phân quyền | `x-roles` cho user, `x-callers` cho service; phải kiểm tra bằng code và ownership tại owner |
| Truy xuất yêu cầu | `x-fr` tham chiếu FR; `x-contract` phân biệt SRS, extension và internal proposal |
| Lỗi nghiệp vụ | `{code,message,correlationId}`, mã HTTP theo SRS; health có schema trạng thái riêng |
| Phân trang | `{items,page,limit,total}`, page ≥ 1, limit 1–100, mặc định 10 |
| ID | String, hỗ trợ ID demo; không bắt client gửi ID giả định theo UUID |
| Tiền | VND, số nguyên không âm; Payment lấy amount từ Fare ở Trip |
| User auth | Bearer JWT; đăng ký/login/OTP public nhưng có rate limit |
| Service auth | Credential riêng cho service, không dùng JWT user thay thế; kiểm tra caller/audience |
| Callback | Chữ ký provider trên raw body; header có mặt chưa đủ để xác thực |
| Idempotency | Payment bắt buộc `Idempotency-Key`; workflow nội bộ dùng registrationId/assignmentId/operationId |

Các schema là mô hình request/response, không phải entity ORM hoặc thiết kế shared database. Customer không giữ credential; Trip không ghi DB Booking/Driver; Payment không tự tính Fare.

## 5. Kiểm tra và cập nhật

Chạy từ root repository, cần Node.js:

```powershell
npm --prefix docs/api_document ci --ignore-scripts
npm --prefix docs/api_document run sync
npm --prefix docs/api_document run check
```

Lệnh check kiểm tra đồng bộ Gateway, JSON/ref, path parameter, security scheme, operationId, độ phủ SRS và topic registry, rồi chạy Swagger Parser cùng Ajv để kiểm tra OpenAPI, event schema và ví dụ/ca biên. Đây là kiểm tra hợp đồng, chưa phải integration test với backend. Cài dependency bằng ci khi có package-lock.json; script validate.cjs cũng có thể chạy độc lập bằng Node.

Sửa API ở file owner hoặc gateway/health.json, sau đó chạy sync để sinh gateway/openapi.json; không sửa tay bản tổng hợp. Khi sửa event, cập nhật producer schema và topic registry. Thay đổi hợp đồng đã chốt phải đối chiếu SRS và thiết kế. Nếu triển khai shared/contracts trong source, dùng quy trình sinh/đồng bộ từ bộ này để tránh hai nguồn sửa tay độc lập.
