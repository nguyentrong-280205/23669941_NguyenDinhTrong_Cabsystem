# booking

Booking, DriverOffer, matching, workflow assignment/cancellation.

- [openapi.json](openapi.json): API qua Gateway.
- [internal.json](internal.json): hợp đồng service-to-service đề xuất, chỉ dùng trong network nội bộ.

Schema nằm ngay trong mỗi file để có thể import độc lập. `x-roles`/`x-callers` mô tả quyền cần thực thi; không thay thế middleware kiểm tra quyền. Các hợp đồng là thiết kế, chưa phải kết quả chạy backend.
