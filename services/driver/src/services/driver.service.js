'use strict';
const C = require('../../../../shared/lib/core');
const { emit } = require('../../../../shared/lib/events');
module.exports = (repository) => {
  async function get(id, tx = repository) {
    const driver = await tx.get('drivers', id);
    C.demand(driver, 404, 'NOT_FOUND', 'Driver not found');
    return driver;
  }
  function safe(driver, staff = false) {
    const { licenseCiphertext, licenseFingerprint, requestHash, position, reservation, ...result } =
      driver;
    if (staff) result.licenseNumber = C.decrypt(licenseCiphertext);
    return result;
  }
  async function view(driver, user) {
    const profile = await C.ipc(
      'identity',
      `/api/v1/internal/users/${encodeURIComponent(driver.userId)}/profiles`,
    );
    const detailed = ['ADMIN', 'OPERATOR'].includes(user.role) || user.driverId === driver.driverId;
    const result = safe(driver, detailed);
    result.fullName = profile.fullName;
    if (detailed) {
      result.phone = profile.phone;
      if (profile.email) result.email = profile.email;
    } else {
      return {
        driverId: driver.driverId,
        fullName: profile.fullName,
        approvalStatus: driver.approvalStatus,
        availabilityStatus: driver.availabilityStatus,
        vehicle: driver.vehicle,
      };
    }
    return result;
  }
  async function nearby(input, internal) {
    C.demand(
      internal || input.user.role !== 'CUSTOMER',
      403,
      'FORBIDDEN',
      'Customers may only view their assigned driver',
    );
    const latitude = Number(input.query.lat),
      longitude = Number(input.query.lng),
      radius = Number(input.query.radiusKm || 1);
    C.demand(
      Number.isFinite(latitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        Number.isFinite(longitude) &&
        longitude >= -180 &&
        longitude <= 180 &&
        radius > 0 &&
        radius <= 5,
      400,
      'VALIDATION_ERROR',
      'Invalid search coordinates or radius',
    );
    C.page(input.query);
    const customer = internal || input.user.role === 'CUSTOMER';
    const filter = customer ? { approvalStatus: 'APPROVED', availabilityStatus: 'AVAILABLE' } : {};
    if (!customer && input.query.status) filter.availabilityStatus = input.query.status;
    if (input.query.vehicleTypeId) filter['vehicle.vehicleTypeId'] = input.query.vehicleTypeId;
    const rows = (await repository.nearby(filter, latitude, longitude, radius))
      .filter((d) => d.location && (!internal || !d.reservation))
      .sort((a, b) => a.distanceMeters - b.distanceMeters || a.driverId.localeCompare(b.driverId));
    const items = [];
    for (const row of rows)
      items.push({
        ...(await view(row, internal ? { role: 'INTERNAL' } : input.user)),
        ...(internal ? { userId: row.userId } : {}),
        distanceKm: Math.round(row.distanceMeters) / 1000,
      });
    return C.paginate(items, input.query);
  }
  const actions = {
    updateOwnLocation: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.user.driverId, tx);
        C.demand(
          !driver.reservation && driver.availabilityStatus !== 'BUSY',
          409,
          'DRIVER_BUSY',
          'Active Trip locations must use Trip API',
        );
        const location = {
          ...input.body,
          locationId: C.hash({ driverId: driver.driverId, ...input.body }),
        };
        await tx.put('drivers', driver.driverId, {
          ...driver,
          location,
          position: { type: 'Point', coordinates: [location.longitude, location.latitude] },
        });
        return { locationId: location.locationId };
      }),
    updateDriverSuspension: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.params.id, tx);
        C.demand(driver.approvalStatus === 'APPROVED');
        const suspended = input.body.suspended;
        await tx.put('drivers', driver.driverId, {
          ...driver,
          suspended,
          onlineIntent: suspended ? false : driver.onlineIntent,
          availabilityStatus: driver.reservation ? 'BUSY' : suspended ? 'SUSPENDED' : 'OFFLINE',
          updatedAt: C.now(),
        });
        await C.audit(tx, 'driver.suspension', driver.driverId);
        return { driverId: driver.driverId, suspended };
      }),
    createDriverRegistration: (input) =>
      repository.tx(async (tx) => {
        const requestHash = C.hash(input.body),
          old = (await tx.list('drivers', { registrationId: input.body.registrationId }))[0];
        if (old) {
          C.demand(
            old.requestHash === requestHash,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Registration reused with different data',
          );
          return {
            registrationId: old.registrationId,
            driverId: old.driverId,
            userId: old.userId,
            approvalStatus: 'PENDING',
            availabilityStatus: 'OFFLINE',
          };
        }
        const driverId = C.id(),
          vehicle = { ...input.body.vehicle, vehicleId: C.id(), driverId, status: 'ACTIVE' };
        C.demand(
          ['VT-4SEATS', 'VT-7SEATS'].includes(vehicle.vehicleTypeId),
          400,
          'VALIDATION_ERROR',
          'Unknown vehicle type',
        );
        const driver = {
          driverId,
          userId: input.body.userId,
          registrationId: input.body.registrationId,
          requestHash,
          licenseCiphertext: C.encrypt(input.body.profile.licenseNumber),
          licenseFingerprint: C.hmac(input.body.profile.licenseNumber, 'ENCRYPTION_KEY'),
          approvalStatus: 'PENDING',
          availabilityStatus: 'OFFLINE',
          onlineIntent: false,
          vehicle,
          createdAt: C.now(),
          updatedAt: C.now(),
          version: 1,
        };
        await tx.create('drivers', driverId, driver);
        await C.audit(tx, 'driver.registered', driverId, driver.userId);
        return safe(driver);
      }),
    getDriverRegistration: async (input) => {
      const row = (
        await repository.list('drivers', { registrationId: input.params.registrationId })
      )[0];
      C.demand(row, 404, 'NOT_FOUND', 'Registration not found');
      return safe(row);
    },
    getDriver: async (input) => {
      const driver = await get(input.params.id);
      if (input.user.role === 'CUSTOMER') {
        const access = await C.ipc(
          'trip',
          `/api/v1/internal-drivers/${encodeURIComponent(driver.driverId)}/customer-accesses`,
          { user: input.user },
        );
        C.demand(access.allowed === true, 403, 'FORBIDDEN', 'Driver is not assigned to your trips');
      } else {
        C.demand(
          ['ADMIN', 'OPERATOR'].includes(input.user.role) ||
            input.user.driverId === driver.driverId,
          403,
          'FORBIDDEN',
          'Driver profile belongs to another user',
        );
      }
      C.demand(
        input.user.role !== 'CUSTOMER' || driver.approvalStatus === 'APPROVED',
        404,
        'NOT_FOUND',
        'Driver not found',
      );
      return view(driver, input.user);
    },
    getNearbyDrivers: (input) => nearby(input, false),
    getNearbyDriversInternal: (input) => nearby(input, true),
    updateAvailability: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.user.driverId, tx);
        C.demand(
          !driver.reservation && driver.availabilityStatus !== 'BUSY',
          409,
          'DRIVER_BUSY',
          'Driver has an active assignment',
        );
        C.demand(
          input.body.availabilityStatus !== 'AVAILABLE' ||
            (driver.approvalStatus === 'APPROVED' && !driver.suspended),
          409,
          'INVALID_STATE',
          'Driver must be approved and not suspended',
        );
        const updated = {
          ...driver,
          availabilityStatus: input.body.availabilityStatus,
          onlineIntent: input.body.availabilityStatus === 'AVAILABLE',
          updatedAt: C.now(),
        };
        await tx.put('drivers', driver.driverId, updated);
        await C.audit(tx, 'driver.availability', driver.driverId);
        return { driverId: driver.driverId, availabilityStatus: updated.availabilityStatus };
      }),
    listDriverApplications: async (input) => {
      const rows = await repository.list('drivers', {
        approvalStatus: input.query.status || 'PENDING',
      });
      const items = [];
      for (const row of rows) items.push(await view(row, input.user));
      return C.paginate(items, input.query);
    },
    reviewDriverApplication: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.params.id, tx);
        C.demand(driver.approvalStatus === 'PENDING');
        const row = {
          ...driver,
          approvalStatus: input.body.decision,
          rejectionReason: input.body.reason || null,
          reviewedAt: C.now(),
          reviewedBy: input.user.userId,
          version: driver.version + 1,
          updatedAt: C.now(),
        };
        await tx.put('drivers', driver.driverId, row);
        await emit(tx, 'driver.application.reviewed', driver.driverId, row.version, {
          driverId: driver.driverId,
          userId: driver.userId,
          approvalStatus: row.approvalStatus,
          reviewedAt: row.reviewedAt,
          ...(input.body.reason ? { rejectionReason: input.body.reason } : {}),
        });
        await C.audit(tx, 'driver.reviewed', driver.driverId);
        return {
          driverId: driver.driverId,
          approvalStatus: row.approvalStatus,
          reviewedAt: row.reviewedAt,
        };
      }),
    reserveDriver: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.params.id, tx);
        if (driver.reservation) {
          C.demand(
            C.hash(driver.reservation.request) === C.hash(input.body),
            409,
            'DRIVER_RESERVED',
            'Driver reserved by another assignment',
          );
          return driver.reservation;
        }
        C.demand(
          driver.approvalStatus === 'APPROVED' &&
            !driver.suspended &&
            driver.availabilityStatus === 'AVAILABLE',
          409,
          'DRIVER_UNAVAILABLE',
          'Driver is unavailable',
        );
        const reservation = {
          ...input.body,
          request: input.body,
          driverId: driver.driverId,
          phase: 'RESERVED',
          reservedAt: C.now(),
        };
        await tx.put('drivers', driver.driverId, { ...driver, reservation });
        return reservation;
      }),
    getReservation: async (input) => {
      const driver = await get(input.params.id);
      C.demand(driver.reservation, 404, 'NOT_FOUND', 'Reservation not found');
      return driver.reservation;
    },
    confirmReservation: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.params.id, tx);
        C.demand(
          driver.reservation?.assignmentId === input.body.assignmentId &&
            driver.reservation.tripId === input.body.tripId,
          409,
          'ASSIGNMENT_CONFLICT',
          'Assignment mismatch',
        );
        const reservation = { ...driver.reservation, phase: 'CONFIRMED' };
        await tx.put('drivers', driver.driverId, {
          ...driver,
          reservation,
          availabilityStatus: 'BUSY',
          updatedAt: C.now(),
        });
        return reservation;
      }),
    releaseReservation: (input) => repository.tx((tx) => release(tx, input.params.id, input.body)),
    recordTripLocation: (input) =>
      repository.tx(async (tx) => {
        const driver = await get(input.params.id, tx),
          key = `${driver.driverId}:${input.body.sampleId}`,
          old = await tx.get('samples', key);
        if (old) {
          C.demand(
            old.requestHash === C.hash(input.body),
            409,
            'IDEMPOTENCY_CONFLICT',
            'Sample ID reused',
          );
          return old.result;
        }
        C.demand(
          driver.reservation?.tripId === input.body.tripId &&
            driver.reservation.phase === 'CONFIRMED',
          409,
          'ASSIGNMENT_CONFLICT',
          'Location must match active Trip',
        );
        const result = {
          locationId: input.body.sampleId,
          latitude: input.body.latitude,
          longitude: input.body.longitude,
          recordedAt: input.body.recordedAt,
        };
        await tx.put('drivers', driver.driverId, {
          ...driver,
          location: result,
          position: { type: 'Point', coordinates: [result.longitude, result.latitude] },
        });
        await tx.create('samples', key, { requestHash: C.hash(input.body), result });
        return result;
      }),
    getDriverLocation: async (input) => {
      const driver = await get(input.params.id);
      return {
        driverId: driver.driverId,
        available: !!driver.location,
        latestLocation: driver.location || null,
        driver: await view(driver, input.actor || { role: 'CUSTOMER' }),
      };
    },
  };
  async function release(tx, driverId, assignment) {
    const driver = await get(driverId, tx);
    if (!driver.reservation) {
      const old = await tx.get('released', `${driverId}:${assignment.assignmentId}`);
      C.demand(
        old && old.tripId === assignment.tripId,
        409,
        'ASSIGNMENT_CONFLICT',
        'Unknown released assignment',
      );
      return old;
    }
    C.demand(
      driver.reservation.assignmentId === assignment.assignmentId &&
        driver.reservation.tripId === assignment.tripId,
      409,
      'ASSIGNMENT_CONFLICT',
      'Cannot release another assignment',
    );
    await tx.put('drivers', driverId, {
      ...driver,
      reservation: null,
      availabilityStatus: driver.suspended
        ? 'SUSPENDED'
        : driver.onlineIntent && driver.approvalStatus === 'APPROVED'
          ? 'AVAILABLE'
          : 'OFFLINE',
      updatedAt: C.now(),
    });
    const released = { ...driver.reservation, phase: 'RELEASED' };
    await tx.put('released', `${driverId}:${assignment.assignmentId}`, released);
    await C.audit(tx, 'driver.released', driverId);
    return released;
  }
  return {
    actions,
    subscriptions: [
      {
        group: 'driver.trip-status',
        topics: ['cab.trip.events'],
        handler: async (tx, event) => {
          if (!['trip.completed', 'trip.canceled'].includes(event.eventType)) return;
          const driver = await tx.get('drivers', event.payload.driverId);
          if (
            driver?.reservation?.assignmentId === event.payload.assignmentId &&
            driver.reservation.tripId === event.payload.tripId
          )
            await release(tx, driver.driverId, event.payload);
        },
      },
    ],
  };
};
