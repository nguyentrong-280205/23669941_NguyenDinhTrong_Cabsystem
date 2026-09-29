# CAB System API Document — bản chuẩn hóa 1.1.0

Các thay đổi chính:

- Bổ sung schema `User` bị thiếu trong `01-account.yaml`, sửa lỗi `$ref` không resolve được.
- Chuẩn hóa `x-fr-traceability` để chỉ chứa FR thực sự được endpoint trong file tham chiếu.
- Bổ sung `operationId` cho toàn bộ operation để thuận tiện cho Swagger/code generation.
- Bổ sung `x-roles` để thể hiện role được phép gọi API.
- Bổ sung response `401`/`403` cho API có xác thực và chuẩn hóa body lỗi theo schema `Error`.
- Tách `serviceAuth` cho API `/internal/*`, không dùng JWT người dùng cho service-to-service.
- Bổ sung `webhookAuth` bằng header `X-Webhook-Signature` cho callback Payment/Notification provider.
- Bổ sung `GET /operator/vehicles/{vehicleId}` để xem chi tiết Vehicle.
- `07-rating.yaml`: SRS hiện không có FR riêng cho UC12 Rating trong FR01–FR59, nên không gán FR giả; endpoint được trace bằng `x-uc: [UC12]` và có ghi chú trong file.
- Phiên bản tài liệu được nâng từ `1.0.0` lên `1.1.0`.

Validation đã chạy: parse YAML, kiểm tra local `$ref`, security scheme reference, `operationId` và error response body.
