# payment

Thanh toán, callback, idempotency và đối soát; Fare lấy từ Trip.

Cho phép trả trước/trong/sau chuyến khi Trip activated, Fare READY và chưa CANCELED. Backend lấy amount từ Fare; client gửi amount bị từ chối. Worker xin payment authorization từ Trip trước khi gọi provider, để ngăn hủy/charge đồng thời. Payment completed vẫn cập nhật Trip PAID qua Kafka. Chi tiết: [cơ chế Fare và trả trước](../../upfront-fare.md).

- [openapi.json](openapi.json): API qua Gateway.
- Service này không cần thêm HTTP nội bộ theo danh mục IPC hiện tại; xử lý bất đồng bộ xem [Kafka](../kafka/README.md).

Schema nằm ngay trong mỗi file để có thể import độc lập. `x-roles`/`x-callers` mô tả quyền cần thực thi; không thay thế middleware kiểm tra quyền. Các hợp đồng là thiết kế, chưa phải kết quả chạy backend.
