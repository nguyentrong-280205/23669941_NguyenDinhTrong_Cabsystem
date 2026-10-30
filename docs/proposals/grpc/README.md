# Đề xuất giao tiếp gRPC

Đây là tài liệu thiết kế mẫu, chưa triển khai trong hệ thống.
Source hiện tại vẫn dùng HTTP/JSON cho giao tiếp đồng bộ và Kafka cho sự kiện.

Sơ đồ đề xuất: Client → HTTP/JSON → Gateway → gRPC → các microservice.
Kafka, Redis và kết nối database giữ nguyên giao thức hiện tại.
Các lời gọi IPC nội bộ giữa service vẫn dùng HTTP/JSON trong đề xuất giới hạn này.

`cab-system.proto` minh họa một số RPC tại biên Gateway/service, không phải
danh sách đầy đủ API. Payload `Struct` là chỗ giữ chỗ cho thông điệp có kiểu cụ thể.
Chưa sinh mã, chưa có gRPC server/client, chưa kiểm thử tích hợp hoặc ánh xạ lỗi.
Không dùng file này làm bằng chứng hệ thống đang chạy gRPC.

Không thay đổi endpoint, request/response Postman hoặc cấu hình Docker hiện tại.
