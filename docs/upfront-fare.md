# Fare lúc tạo Trip và thanh toán trước

Customer tạo Booking → Driver ACCEPTED Offer → Trip được tạo ở ASSIGNED với Fare READY → assignment được xác nhận, activated=true → Customer có thể thanh toán ngay. Lifecycle và quyền Customer/Driver/staff giữ nguyên.

Trip Service tính Haversine từ pickup/destination bằng bán kính Trái Đất 6371 km. `distanceKm` làm tròn 6 chữ số thập phân; khoảng cách dương có mức nhỏ nhất 0.000001 km để không mất quãng đường nhỏ. Hai tọa độ giống nhau cho distanceKm=0 và cước bằng baseFare. Đây là khoảng cách ước tính đường thẳng, không phải khoảng cách tuyến đường giao thông. Tọa độ không hợp lệ trả 400; thiếu PricingRule trả 409, không tạo Trip/Fare dở dang.

PricingRule được chọn theo vehicleTypeId và phiên bản cao nhất, giữ chính sách chọn giá hiện tại. Snapshot giá được lưu vào Trip. `durationMinutes=0` khi chưa có dự kiến thời gian; không tạo thời gian giả. Fare gồm fareId, baseFare, distanceFare, timeFare, totalAmount, currency VND. Mỗi thành phần cước theo quãng đường/thời gian làm tròn đến đồng:

```text
distanceFare = round(distanceKm × perKmRate)
timeFare = round(durationMinutes × perMinuteRate)
totalAmount = baseFare + distanceFare + timeFare
```

Trip và Fare được lưu cùng transaction. Retry assignment trả Trip/Fare cũ. `POST /trips/{id}/locations` vẫn lưu vị trí qua Driver Service và cập nhật latestLocation; quãng đường đo được lưu ở trackedDistanceKm riêng. Các mẫu trùng không cộng lại quãng đường. Tracking và chuyển COMPLETED không tạo Fare mới hay thay đổi Fare đã chốt.

Payment chỉ nhận tripId và method ELECTRONIC; amount từ client bị từ chối. Điều kiện: Trip activated=true, Fare READY, trạng thái ASSIGNED/DRIVER_ARRIVING/DRIVER_ARRIVED/PICKED_UP/IN_PROGRESS/COMPLETED, paymentStatus chưa PAID. Idempotency-Key, khóa active/completed Payment theo tripId, callback HMAC, outbox/inbox và provider key bằng paymentId giữ nguyên.

Trước khi gọi provider, job đã lưu trong Payment xin `POST /api/v1/internal-trips/{id}/payment-authorizations`, chỉ Payment Service được gọi. Trip xác minh customerId, fareId, amount/currency và khóa paymentId trong transaction cùng owner với hủy Trip. Nếu hủy thắng trước authorization, job chuyển FAILED mà không gọi provider. Nếu authorization thắng, hủy trả 409 PAYMENT_IN_PROGRESS cho đến khi kết quả thanh toán đến. Timeout provider không tự mở khóa vì có thể đã charge; job retry với cùng paymentId. Event payment.failed chỉ mở khóa reservation tương ứng. Event payment.completed cập nhật PAID qua Kafka; Trip PAID trả 409 TRIP_ALREADY_PAID khi hủy vì chưa có refund.

Trip cũ có Fare giữ nguyên cả fareId/số tiền/khoảng cách, kể cả Fare seed không có fareStatus. Payment context nhận diện Fare đó là READY. Trip cũ chưa thanh toán, chưa có Fare được bổ sung theo pickup/destination và pricing snapshot khi GET Trip/GET Fare/lấy payment context hoặc hoàn thành; thiếu snapshot thì dùng PricingRule tương ứng. Trip cũ đã PAID nhưng thiếu Fare không được tính lại tự động: cần đối soát riêng. Chuyến COMPLETED cũ đang PENDING được worker thử bổ sung Fare bằng dữ liệu tuyến, không cần mẫu tracking. Không có reset database hay ghi lại Payment COMPLETED.

## Test thủ công qua Gateway

1. Tạo Booking và cho Driver nhận Offer như [bước 15–16](demo_data.md). Lưu tripId/bookingId. Dùng Customer sở hữu chuyến GET `/api/v1/trips/{tripId}`: ASSIGNED, activated=true, distanceKm dương với hai tọa độ khác nhau, fareStatus READY. GET `/api/v1/trips/{tripId}/fares` trả 200; lưu fareId và totalAmount.
2. Dùng Customer gửi POST `/api/v1/payments`, header `Idempotency-Key: upfront-<tripId>-v1`, body `{"tripId":"<tripId>","method":"ELECTRONIC"}`. Response 202 trả paymentId. Gửi lại cùng key/body phải trả cùng paymentId. Đổi key khi đã có Payment active/completed trả 409.
3. Poll GET `/api/v1/payments/{paymentId}` đến COMPLETED; sandbox gọi callback HMAC tự động. Poll GET Trip đến paymentStatus PAID. Khi Trip vẫn ASSIGNED, thử PATCH Booking với `{"status":"CANCELED","reason":"test paid cancellation"}`: 409 TRIP_ALREADY_PAID. Khi callback chưa xong và authorization đã có, kết quả là 409 PAYMENT_IN_PROGRESS.
4. Driver PATCH Trip lần lượt DRIVER_ARRIVING → DRIVER_ARRIVED → PICKED_UP → IN_PROGRESS; POST các location; GET Trip vẫn cùng distanceKm/Fare nhưng latestLocation cập nhật. Chuyển COMPLETED rồi GET Fare: fareId/số tiền không đổi, paymentStatus vẫn PAID.
5. Tạo chuyến riêng chưa thanh toán để test hủy trước PICKED_UP. Không dùng chuyến đã PAID để test hủy thành công. Thêm amount vào POST Payment trả 400; token Customer khác trả 403; Trip chưa activated, thiếu Fare READY hoặc đã CANCELED không được thanh toán.

## Kiểm tra và build

```powershell
npm test
npm run check:api
docker compose up -d --build trip-service payment-service booking-service gateway
```

Lệnh build giữ volume/dữ liệu. Không cần chạy lại seed. Xác nhận `GET http://localhost:8081/api/v1/ready` rồi chạy quy trình test trên. Test Node dùng HTTP Gateway/service thật với kho dữ liệu transaction trong bộ nhớ và event consumer/outbox được drain trong test; chúng không chứng minh Kafka/PostgreSQL/MongoDB thật đã chạy thành công. `scripts/smoke-docker.cjs` với SMOKE_FULL=true dùng hạ tầng thật, tạo thêm dữ liệu demo và kiểm tra trả trước/lifecycle sau thanh toán.

## File thay đổi

| File | Mục đích |
|---|---|
| `services/trip/src/services/trip.service.js` | Chốt Haversine/Fare, tương thích Trip cũ, tách tracking, payment authorization, chặn hủy khi PAID và xử lý payment.failed/completed |
| `services/trip/src/controllers/trip.controller.js`, `services/trip/src/routes/trip.routes.js` | Khai báo và xử lý API payment authorization nội bộ, chỉ Payment được gọi |
| `services/payment/src/services/payment.service.js` | Cho phép trả trước và xác nhận với Trip trước khi charge; giữ provider/idempotency/HMAC |
| `services/booking/src/services/booking.service.js` | Giữ mã lỗi hủy, cho phép retry cùng lý do sau khi Payment thất bại |
| `docs/api_document/trip/openapi.json`, `docs/api_document/trip/internal.json`, `docs/api_document/payment/openapi.json`, `docs/api_document/gateway/openapi.json` | Cập nhật schema/điều kiện thanh toán và đồng bộ contract Gateway |
| `tests/upfront-fare.test.cjs`, `tests/system.test.cjs`, `tests/recovery.test.cjs` | Kiểm tra Fare/trả trước/lifecycle/legacy/retry/race và cập nhật kỳ vọng cũ |
| `scripts/smoke-docker.cjs` | Thêm quy trình kiểm tra trả trước với hạ tầng thật khi SMOKE_FULL=true |
| `README.md`, `docs/api_document/trip/README.md`, `docs/api_document/payment/README.md`, `docs/upfront-fare.md` | Giải thích cơ chế mới và hướng dẫn test/build |
| `docs/demo_data.md` | Cập nhật các bước demo cục bộ; file này đã nằm trong .gitignore của dự án |

Thay đổi có sẵn của người dùng tại `services/gateway/src/controllers/gateway.controller.js` được giữ nguyên. Các thay đổi có sẵn trong `tests/system.test.cjs` cũng được giữ khi bổ sung test trả trước.
