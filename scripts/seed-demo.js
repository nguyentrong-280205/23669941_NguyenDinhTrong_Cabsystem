'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { createStore } = require('../shared/lib/store');
const C = require('../shared/lib/core');
async function main() {
  const stores = {};
  try {
    for (const service of ['identity','customer','driver','booking','trip','payment','notification']) {
      if (process.env.SEED_CONTAINER === 'true') {
        Object.assign(process.env, { DB_HOST:'postgres',DB_NAME:`${service}_db`,DB_USER:`${service}_user`,DB_PASSWORD:process.env[`${service.toUpperCase()}_DB_PASSWORD`],MONGO_DB:`${service}_db`,MONGO_URI:`mongodb://${service}_user:${process.env[`${service.toUpperCase()}_DB_PASSWORD`]}@mongodb:27017/${service}_db?replicaSet=rs0&authSource=${service}_db` });
      } else Object.assign(process.env, require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, `../services/${service}/.env`))));
      const store = createStore(service); await store.init(); stores[service] = store;
    }
    const passwordHash = await bcrypt.hash('123456', 12);
    const users = [ { userId: 'USR-ADMIN', fullName: 'System Admin', role: 'ADMIN', email: 'admin@cab.com' }, ...['A','B'].map(s => ({ userId: `USR-${s}`, customerId: `CUS-${s}`, fullName: `Customer ${s}`, role: 'CUSTOMER', email: `customer${s.toLowerCase()}@cab.com` })), ...Array.from({ length: 8 }, (_,i) => ({ userId: `USR-DRV-${i+1}`, driverId: `DRV-${i+1}`, fullName: `Driver ${i+1}`, role: 'DRIVER', email: `driver${i+1}@cab.com` })) ];
    await stores.identity.tx(async tx => {
      // Reset demo login passwords even when containers are recreated with existing volumes.
      for (const user of await tx.list('users')) await tx.put('users', user.userId, { ...user, passwordHash, updatedAt: C.now() });
      for (const user of users) if (!await tx.get('users', user.userId)) await tx.create('users', user.userId, { ...user, passwordHash, status: 'ACTIVE', registrationStatus: 'COMPLETED', createdAt: C.now(), updatedAt: C.now() });
    });
    await stores.customer.tx(async tx => { for (const s of ['A','B']) if (!await tx.get('customers', `CUS-${s}`)) await tx.create('customers', `CUS-${s}`, { customerId: `CUS-${s}`, userId: `USR-${s}`, registrationId: `REG-${s}`, defaultPaymentMethod: 'CASH', createdAt: C.now(), updatedAt: C.now() }); });
    await stores.driver.tx(async tx => {
      const approval = ['APPROVED','APPROVED','APPROVED','APPROVED','APPROVED','APPROVED','PENDING','PENDING'];
      const availability = ['AVAILABLE','AVAILABLE','BUSY','OFFLINE','SUSPENDED','AVAILABLE','OFFLINE','OFFLINE'];
      const latitude = [10.7787,10.7841,10.7805,10.7823,10.7832,10.7877,10.777,10.778];
      for (let i=0;i<8;i++) {
        const driverId = `DRV-${i+1}`; if (await tx.get('drivers', driverId)) continue;
        const license = `DEMO-LICENSE-${i+1}`;
        await tx.create('drivers', driverId, { driverId, userId: `USR-DRV-${i+1}`, registrationId: `REG-DRV-${i+1}`, licenseCiphertext: C.encrypt(license), licenseFingerprint: C.hmac(license,'ENCRYPTION_KEY'), approvalStatus: approval[i], availabilityStatus: availability[i], onlineIntent: availability[i] === 'AVAILABLE', vehicle: { vehicleId: `VEH-${i+1}`, driverId, vehicleTypeId: 'VT-4SEATS', plateNumber: `DEMO-${i+1}`, status: 'ACTIVE' }, position: { type:'Point',coordinates:[106.7009,latitude[i]] }, location: { locationId: `LOC-${i+1}`, latitude: latitude[i], longitude: 106.7009, recordedAt: C.now() }, version:1, createdAt:C.now(), updatedAt:C.now() });
      }
    });
    await stores.trip.tx(async tx => {
      for (const [type,base,km] of [['VT-4SEATS',15000,10000],['VT-7SEATS',20000,13000]]) if (!await tx.get('pricing', type)) await tx.create('pricing', type, { pricingRuleId:type,vehicleTypeId:type,effectiveFrom:'2026-01-01T00:00:00.000Z',baseFare:base,perKmRate:km,perMinuteRate:0,version:1 });
    });
    for (const s of ['A','B']) for (let i=1;i<=(s==='A'?5:1);i++) {
      const bookingId=`BKG-${s}-${i}`,tripId=`TRIP-${s}-${i}`,assignmentId=`ASSIGN-${s}-${i}`,status=i===5?'ASSIGNED':'COMPLETED';
      const pickup={lat:10.7769,lng:106.7009,address:'Demo pickup'},destination={lat:10.785,lng:106.71,address:'Demo destination'};
      const fare={fareId:`FARE-${s}-${i}`,tripId,pricingRuleId:'VT-4SEATS',pricingVersion:1,totalAmount:50000,currency:'VND',calculatedAt:C.now()};
      await stores.trip.tx(async tx => { if (!await tx.get('trips',tripId)) await tx.create('trips',tripId,{tripId,bookingId,assignmentId,customerId:`CUS-${s}`,driverId:'DRV-3',vehicleId:'VEH-3',vehicleTypeId:'VT-4SEATS',pickup,destination,status,activated:true,paymentStatus:'UNPAID',distanceKm:3.5,durationMinutes:10,pricingSnapshot:await tx.get('pricing','VT-4SEATS'),...(status==='COMPLETED'?{fare}:{}),version:1,createdAt:C.now(),updatedAt:C.now()}); });
      await stores.booking.tx(async tx => { if (!await tx.get('bookings',bookingId)) await tx.create('bookings',bookingId,{bookingId,tripId,assignmentId,customerId:`CUS-${s}`,assignedDriverId:'DRV-3',vehicleTypeId:'VT-4SEATS',pickup,destination,status:status==='COMPLETED'?'COMPLETED':'DRIVER_ASSIGNED',version:1,createdAt:C.now(),updatedAt:C.now()}); if (!await tx.get('assignments',assignmentId)) await tx.create('assignments',assignmentId,{assignmentId,bookingId,tripId,driverId:'DRV-3',status:'COMPLETED'}); });
    }
    const activeFixture = await stores.trip.get('trips','TRIP-A-5');
    await stores.driver.tx(async tx=>{const d=await tx.get('drivers','DRV-3');if (!d.reservation && !['COMPLETED','CANCELED'].includes(activeFixture.status)) await tx.put('drivers','DRV-3',{...d,reservation:{assignmentId:'ASSIGN-A-5',bookingId:'BKG-A-5',tripId:'TRIP-A-5',driverId:'DRV-3',phase:'CONFIRMED'}});});
    const late={tripId:'TRIP-LATE',bookingId:'BKG-LATE',assignmentId:'ASSIGN-LATE',customerId:'CUS-A',driverId:'DRV-4',vehicleId:'VEH-4',vehicleTypeId:'VT-4SEATS',pickup:{lat:10.7769,lng:106.7009,address:'Demo pickup'},destination:{lat:10.785,lng:106.71,address:'Demo destination'},status:'PICKED_UP',activated:true,paymentStatus:'UNPAID',distanceKm:0,durationMinutes:0,version:1,createdAt:C.now(),updatedAt:C.now()};
    await stores.trip.tx(async tx=>{if(!await tx.get('trips',late.tripId))await tx.create('trips',late.tripId,{...late,pricingSnapshot:await tx.get('pricing','VT-4SEATS')});});
    await stores.booking.tx(async tx=>{if(!await tx.get('bookings',late.bookingId)){await tx.create('bookings',late.bookingId,{...late,status:'DRIVER_ASSIGNED',assignedDriverId:'DRV-4'});await tx.create('assignments',late.assignmentId,{assignmentId:late.assignmentId,bookingId:late.bookingId,tripId:late.tripId,driverId:'DRV-4',status:'COMPLETED'});}});
    const currentLate = await stores.trip.get('trips',late.tripId);
    await stores.driver.tx(async tx=>{const d=await tx.get('drivers','DRV-4');if(!d.reservation && !['COMPLETED','CANCELED'].includes(currentLate.status))await tx.put('drivers','DRV-4',{...d,availabilityStatus:'BUSY',reservation:{assignmentId:late.assignmentId,bookingId:late.bookingId,tripId:late.tripId,driverId:'DRV-4',phase:'CONFIRMED'}});});
    console.log('Demo seeded; all existing User passwords reset to the demo password. Other existing data preserved: 2 Customers, 8 Drivers, linked Bookings/Trips/Fares and late-cancel fixture. Login emails: admin@cab.com, customera@cab.com, customerb@cab.com, driver1@cab.com.');
  } finally { for (const store of Object.values(stores)) await store.close(); }
}
main().catch(() => { console.error('Seed failed; check dependencies and owner credentials'); process.exitCode=1; });
