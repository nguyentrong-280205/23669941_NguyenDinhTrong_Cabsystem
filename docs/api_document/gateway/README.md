# gateway

Entry point ngoài, JWT/rate limit, routing và health. File OpenAPI tổng hợp dùng cho import.

- [openapi.json](openapi.json): API qua Gateway (bản tổng hợp).
- [health.json](health.json): nguồn 3 endpoint health; sửa ở đây rồi chạy `npm --prefix docs/api_document run sync` từ root.

Schema nằm ngay trong mỗi file để có thể import độc lập. `x-roles`/`x-callers` mô tả quyền cần thực thi; không thay thế middleware kiểm tra quyền. Các hợp đồng là thiết kế, chưa phải kết quả chạy backend.
