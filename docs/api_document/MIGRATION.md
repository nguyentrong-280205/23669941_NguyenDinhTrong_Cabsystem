# Chuyển từ nhóm chức năng sang service owner

Bộ YAML api-document/ phiên bản 1.1.0 là tài liệu trước khi chuyển sang kiến trúc hiện tại, đã được bỏ khỏi cây thư mục làm việc. Bộ hiện hành docs/api_document/ phiên bản 2.1.0 bám SRS X, Customer/Trip riêng, Kafka và phân chia PostgreSQL/MongoDB. Bảng dưới ghi lịch sử chuyển đổi, không yêu cầu khôi phục bộ YAML cũ và không xác nhận đã migrate backend/dữ liệu.

## Ánh xạ tài liệu cũ

| File cũ | Owner trong kiến trúc mới | Hướng xử lý |
|---|---|---|
| `01-account.yaml` | Identity | Đăng ký Customer/Driver tách route; bổ sung OTP. Hồ sơ nghiệp vụ Customer chuyển Customer |
| `02-booking.yaml` | Booking; VehicleType thuộc Driver | Tạo/list/hủy Booking về Booking; route chọn loại xe mở rộng phải do Driver sở hữu |
| `03-driver-dispatch.yaml` | Driver và Booking | Availability/location/reservations thuộc Driver; Offer/accept/reject/matching thuộc Booking |
| `04-trip-tracking.yaml` | Trip, phối hợp Driver | Trip/status/tracking thuộc Trip; vị trí lưu ở Driver qua API nội bộ |
| `05-payment.yaml` | Payment và Trip | Payment/callback thuộc Payment; Fare/Pricing thuộc Trip |
| `06-notification.yaml` | Notification | API đọc theo user; delivery lấy từ Kafka và worker. Không yêu cầu service khác POST thông báo thay domain event |
| `07-rating.yaml` | Trip | Rating tại Trip Service, liên kết FR39/UC12 |
| `08-operations-security.yaml` | Theo owner | Customer → Customer; Driver/Vehicle → Driver; Trip → Trip; Role/User → Identity. Audit ghi cục bộ, không tạo service Audit riêng |

## Hợp đồng nghiệm thu đã chuẩn hóa

| Hợp đồng cũ | Hợp đồng theo SRS mới |
|---|---|
| Base URL `/api/v1` | Gateway dùng prefix `/api/v1` |
| `POST /auth/register` với role | `/api/v1/customers`, `/api/v1/drivers`; Driver có hai bước OTP |
| Login dùng `login` | `phone` hoặc `email`, cùng `password`; response có tokenType/expiresIn |
| `POST /api/v1/bookings` | `POST /api/v1/bookings` |
| Danh sách Booking chung | `GET /api/v1/bookings?customerId={id}`, kiểm tra chính chủ |
| `/driver/trip-offers` | `/api/v1/booking-offers` |
| `/driver/trip-offers/{offerId}/acceptances` | `/api/v1/booking-offers/{id}`, owner Booking |
| `DELETE /api/v1/bookings/{bookingId}` | `PATCH /api/v1/bookings/{id}` với reason |
| `/api/v1/trips/{tripId}/locations/latest` | `POST /api/v1/trips/{id}/locations`, qua Trip tới Driver |
| `/api/v1/trips/{tripId}/rating` | `POST /api/v1/trips/{id}/reviews`, owner Trip |
| Tạo payment dưới `/api/v1/trips/{tripId}/payment` | `POST /api/v1/payments`, body tripId/method và Idempotency-Key |
| `/api/v1/payments/webhook` | `/api/v1/payment-callbacks` có xác minh chữ ký |
| Payment `SUCCESS` | Payment `COMPLETED`; Trip.paymentStatus là `PAID` |
| Driver `UNAVAILABLE` | `OFFLINE`; các trạng thái khác theo enum SRS |
| Danh sách dạng array | `{items,page,limit,total}` |
| Validation 422 ở bộ cũ | 400 theo hợp đồng nghiệm thu SRS |

## Các API mở rộng cần đặc tả tiếp

Các API sau chưa được đưa vào bộ hợp đồng nghiệm thu mới. Chức năng nghiệp vụ vẫn theo SRS; cần chốt method/path và request/response trước khi triển khai:

- Identity: `/me`, quản lý Role và đổi role User.
- Customer: danh sách/cập nhật/khóa Customer ở nhóm `/operator/customers*`; khóa User phải gọi Identity bằng operationId.
- Driver: `/vehicle-types`, quản lý Driver/Vehicle, vị trí Driver ngoài Trip.
- Booking: validate/detail Booking, báo cáo; matching chạy trong Booking qua worker, không bắt buộc giữ HTTP `/api/v1/internal-dispatch/*` cũ.
- Trip: history/tracking riêng, dashboard active/support, quản trị PricingRule hoặc yêu cầu tính lại Fare. GET Fare đã có như extension trong bộ mới.
- Payment: danh sách quản trị, retry/reconcile phải có chính sách idempotency; không dùng retry mù quáng.
- Notification: detail/đánh dấu đã đọc, callback delivery tùy provider; không public `/api/v1/internal-*` qua Gateway.
- Audit: lưu tại service phát sinh. Route tổng hợp audit chỉ bổ sung sau khi chốt cách tổng hợp theo quyền; không dùng endpoint ghi audit tập trung để thay transaction audit cục bộ.

Không có cam kết tương thích runtime cho route cũ. Khi code, dùng SRS X và docs/api_document/ làm hợp đồng hiện hành; xem bảng trên để đối chiếu phần mở rộng còn cần đặc tả.
