# trip

Trip, tracking, Pricing/Fare và Rating; projection PAID từ Payment.

Trip mới chốt khoảng cách Haversine và Fare ngay khi ASSIGNED. GET Fare hoạt động trước khi hoàn thành. Tracking ghi `trackedDistanceKm` riêng, không thay đổi Fare; COMPLETED giữ nguyên fareId. Trip đã PAID hoặc đang có payment authorization không thể hủy. Chi tiết: [cơ chế Fare và trả trước](../../upfront-fare.md).

- [openapi.json](openapi.json): API qua Gateway.
- [internal.json](internal.json): hợp đồng service-to-service đề xuất, chỉ dùng trong network nội bộ.

Schema nằm ngay trong mỗi file để có thể import độc lập. `x-roles`/`x-callers` mô tả quyền cần thực thi; không thay thế middleware kiểm tra quyền. Các hợp đồng là thiết kế, chưa phải kết quả chạy backend.
