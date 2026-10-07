# Cấu trúc source theo các tầng

Microservice được tách theo bounded context và quyền sở hữu dữ liệu. Bên trong mỗi service, project dùng cấu trúc theo tầng để dễ đọc, kiểm thử và trình bày.

```text
services/driver/
├── src/
│   ├── config/index.js
│   ├── routes/driver.routes.js
│   ├── controllers/driver.controller.js
│   ├── services/driver.service.js
│   ├── repositories/driver.repository.js
│   ├── models/index.js
│   ├── index.js
│   ├── app.js
│   └── server.js
├── Dockerfile
├── package.json
└── .env.example
```

| Tầng | Trách nhiệm | Ví dụ Driver |
|---|---|---|
| config | Load env của owner, kiểm tra biến bắt buộc, chọn port | MongoDB URI/DB, Kafka brokers |
| routes | Khai báo method/path, action và caller được phép cho IPC | PATCH /api/v1/drivers/me → updateAvailability |
| controllers | Chuyển Express request thành input cho nghiệp vụ; trả status/body theo contract, chuyển lỗi sang middleware | Nhận body/user, gọi updateAvailability, trả JSON |
| services | Kiểm tra quy tắc nghiệp vụ, điều phối IPC, transaction, workflow và event | Chỉ APPROVED, không suspended và không có assignment mới được AVAILABLE |
| repositories | Cung cấp thao tác đọc/ghi và transaction cho persistence của owner | get/list/tx; Driver có nearby dùng MongoDB geo query |
| models / migrations | Validator/index MongoDB hoặc schema/migration PostgreSQL | Driver models; Identity/Booking/Payment migrations |

Tài liệu OpenAPI trong `docs/api_document` vẫn là nguồn schema validation. Route file khai báo endpoint thực thi, còn runtime chung ghép validation/auth vào controller. Điều này tránh sao chép schema vào từng route. Controllers không quyết định rule nghiệp vụ; services không nhận Express `req`, `res` hay `next`, chỉ nhận input object.

## Đọc một API theo thứ tự

Ví dụ `PATCH /api/v1/drivers/me`:

1. [driver.routes.js](../../services/driver/src/routes/driver.routes.js) chọn action `updateAvailability`.
2. Runtime kiểm tra JWT, role và body theo OpenAPI; [driver.controller.js](../../services/driver/src/controllers/driver.controller.js) gọi action với input của request.
3. [driver.service.js](../../services/driver/src/services/driver.service.js) đọc Driver, kiểm tra trạng thái duyệt/suspension/reservations rồi cập nhật availability trong transaction và ghi audit.
4. [driver.repository.js](../../services/driver/src/repositories/driver.repository.js) cung cấp persistence cho nghiệp vụ; adapter MongoDB nằm trong `shared/lib/store.js`.
5. Controller kiểm tra response với contract rồi trả JSON/status. Lỗi được xử lý bởi middleware dùng chung.

`src/index.js` là composition root: tạo repository từ store, tạo service từ repository, tạo controllers từ service và gắn routes. `app.js` tạo Express app từ các thành phần đó; `server.js` gọi startup với config của owner. Khi test, có thể inject persistence double tại `app.js` mà vẫn chạy đúng routes/controllers/services/repositories như production.

## Các thành phần khác

- Kafka subscriptions, outbox và workflow worker thuộc nghiệp vụ trong service; producer/consumer/inbox/offset là cơ chế chung trong `shared/lib/events.js`.
- Repository của 3 owner PostgreSQL dùng aggregate JSONB có migration; repository của 4 owner MongoDB dùng model/index. Không có database dùng chung giữa các owner.
- Gateway có `config/routes/controllers/services/repositories` và middleware auth riêng. Repository chỉ truy cập Redis cho rate limit; service thực hiện proxy/readiness. Gateway không có model nghiệp vụ hay migration database.
- `shared/lib` chứa kỹ thuật dùng chung: storage adapter, HTTP response, schema validation, JWT/IPC, Kafka và startup. Không chứa quy tắc Customer/Driver/Booking/Trip/Payment.
- File `domain.js` trước khi tách đã được lưu trong `docs/legacy-source/<owner>/domain.before-layering.js.txt`, không được import bởi runtime. Các thư mục trống không dùng đến được bỏ để cấu trúc phản ánh code hiện có.

Hợp đồng API, database, dữ liệu và luồng nghiệp vụ được giữ nguyên trong lần tách tầng này.

Kiểm tra sau khi tách: 20 test đạt, kiểm tra OpenAPI/Gateway đạt, build/startup Docker đạt. Full smoke với DB/Kafka thật đạt luồng đặt xe → offer → assignment → tracking/Fare → release Driver và thanh toán idempotent qua sandbox/HMAC → Trip PAID.

Có thể chạy `npm run format:services` để giữ định dạng JavaScript nhất quán; formatter được cố định phiên bản trong lockfile.
