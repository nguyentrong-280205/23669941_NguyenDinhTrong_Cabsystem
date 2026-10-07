# Kafka integration contracts

[topics.json](topics.json) là registry thiết kế, mô tả producer, partition key, consumer group và eventType được xử lý. Đây không phải cấu hình broker chạy trực tiếp hoặc tài liệu AsyncAPI.

| Topic | Producer | Schema |
|---|---|---|
| `cab.booking.events` | Booking | [booking.events.schema.json](booking.events.schema.json) |
| `cab.trip.events` | Trip | [trip.events.schema.json](trip.events.schema.json) |
| `cab.payment.events` | Payment | [payment.events.schema.json](payment.events.schema.json) |
| `cab.driver.events` | Driver | [driver.events.schema.json](driver.events.schema.json) |
| `cab.identity.otp` | Identity | [identity.events.schema.json](identity.events.schema.json) |

Các schema dùng JSON Schema draft 2020-12, tham chiếu [envelope chung](event-envelope.schema.json). Envelope có `version` là phiên bản schema, `aggregateVersion` là phiên bản dữ liệu nghiệp vụ. Ví dụ [payment.completed](examples/payment.completed.json) có partition key `TRIP-001`, dù aggregateId của Payment là `PAY-001`.

Payload là hợp đồng tối thiểu đề xuất. Consumer gọi API owner nếu cần dữ liệu hiện tại; event không cho phép ghi DB của producer. `trip.completed` không yêu cầu Fare đã tính thành công, vì lỗi tính Fare không được giữ Driver BUSY; Payment chỉ thực hiện khi payment-context xác nhận Fare hợp lệ.

OTP chỉ có ciphertext và keyVersion; phone/mã OTP nằm trong encryptedPayload, không vào log/content thông báo lịch sử. Consumer kiểm tra expiresAt; retention topic không thay TTL nghiệp vụ. Không xem chuỗi ví dụ ciphertext như cơ chế mã hóa đã triển khai.

Outbox được ghi cùng transaction nghiệp vụ; producer đánh dấu gửi sau acknowledgement. PostgreSQL dùng SQL transaction; MongoDB dùng session/transaction trên replica set, trong DB của owner. Consumer lưu inbox/thay đổi DB nguyên tử rồi commit offset, chống trùng bằng eventId. Các group khác nhau xử lý cùng event độc lập; event không thuộc trách nhiệm được bỏ qua có kiểm soát. Retry có giới hạn và DLT theo [SRS 9.3](../../requirements/srs.md#93-ipc-và-độ-tin-cậy).

Tên DLT đề xuất: `<source-topic>.<consumer-group>.dlt`; giữ metadata nguồn, attempts và lỗi đã mask. Chỉ commit offset nguồn sau khi ghi DLT thành công. Replay giữ eventId; kiểm tra aggregateVersion/trạng thái và đối soát nếu bỏ qua event làm thiếu bước nghiệp vụ.
