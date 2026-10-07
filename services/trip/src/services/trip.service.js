'use strict';
const C = require('../../../../shared/lib/core');
const { emit } = require('../../../../shared/lib/events');
const transitions = {
  ASSIGNED: ['DRIVER_ARRIVING', 'DRIVER_ARRIVED'],
  DRIVER_ARRIVING: ['DRIVER_ARRIVED'],
  DRIVER_ARRIVED: ['PICKED_UP'],
  PICKED_UP: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
};
function distance(a, b) {
  const rad = (x) => (x * Math.PI) / 180,
    lat = rad(b.latitude - a.latitude),
    lng = rad(b.longitude - a.longitude);
  return (
    6371 *
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(lat / 2) ** 2 +
            Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(lng / 2) ** 2,
        ),
      ),
    )
  );
}
module.exports = (repository) => {
  function calculateFare(trip) {
    C.demand(
      trip.startedAt &&
        trip.lastSample &&
        Number.isFinite(trip.distanceKm) &&
        trip.distanceKm >= 0 &&
        trip.pricingSnapshot,
      409,
      'METRICS_MISSING',
      'Tracking metrics or pricing snapshot require reconciliation',
    );
    const rule = trip.pricingSnapshot;
    C.demand(
      ['baseFare', 'perKmRate', 'perMinuteRate'].every(
        (k) => Number.isFinite(rule[k]) && rule[k] >= 0,
      ),
      409,
      'PRICING_INVALID',
      'Invalid pricing snapshot',
    );
    const distanceFare = Math.round(trip.distanceKm * rule.perKmRate),
      timeFare = 0;
    return {
      fareId: C.id(),
      tripId: trip.tripId,
      pricingRuleId: rule.pricingRuleId,
      pricingVersion: rule.version,
      baseFare: rule.baseFare,
      distanceFare,
      timeFare,
      totalAmount: rule.baseFare + distanceFare + timeFare,
      currency: 'VND',
      calculatedAt: C.now(),
    };
  }
  async function get(id, tx = repository) {
    const trip = await tx.get('trips', id);
    C.demand(trip, 404, 'NOT_FOUND', 'Trip not found');
    return trip;
  }
  function canView(user, trip) {
    C.demand(
      ['ADMIN', 'OPERATOR'].includes(user.role) ||
        user.customerId === trip.customerId ||
        user.driverId === trip.driverId,
      403,
      'FORBIDDEN',
      'Trip belongs to another user',
    );
  }
  const payload = (trip) => ({
    tripId: trip.tripId,
    assignmentId: trip.assignmentId,
    bookingId: trip.bookingId,
    customerId: trip.customerId,
    driverId: trip.driverId,
  });
  async function operation(input, action) {
    return repository.tx(async (tx) => {
      const key = `${action}:${input.body.operationId}`,
        requestHash = C.hash({ tripId: input.params.id, ...input.body });
      let trip = await tx.get('trips', input.params.id);
      if (!trip && action === 'cancel') {
        const old = await tx.get('tombstones', input.params.id);
        C.demand(
          !old || old.assignmentId === input.body.assignmentId,
          409,
          'ASSIGNMENT_CONFLICT',
          'Assignment mismatch',
        );
        await tx.put('tombstones', input.params.id, {
          assignmentId: input.body.assignmentId,
          operationId: input.body.operationId,
          reason: input.body.reason,
        });
        return { tripId: input.params.id, status: 'CANCELED' };
      }
      C.demand(trip, 404, 'NOT_FOUND', 'Trip not found');
      const previous = await tx.get('operations', key);
      C.demand(
        trip.assignmentId === input.body.assignmentId,
        409,
        'ASSIGNMENT_CONFLICT',
        'Assignment mismatch',
      );
      if (previous) {
        C.demand(
          previous.requestHash === requestHash,
          409,
          'IDEMPOTENCY_CONFLICT',
          'Operation reused',
        );
        return previous.result;
      }
      if (action === 'activate') {
        C.demand(trip.status !== 'CANCELED');
        if (!trip.activated) {
          const row = { ...trip, activated: true, version: trip.version + 1 };
          await tx.put('trips', trip.tripId, row);
          await emit(tx, 'driver.assigned', trip.tripId, row.version, payload(trip));
        }
      } else {
        C.demand(
          !['PICKED_UP', 'IN_PROGRESS', 'COMPLETED'].includes(trip.status),
          409,
          'TRIP_ALREADY_IN_PROGRESS',
          'Cannot cancel after pickup',
        );
        if (trip.status !== 'CANCELED') {
          const row = {
            ...trip,
            status: 'CANCELED',
            reason: input.body.reason,
            canceledAt: C.now(),
            version: trip.version + 1,
            updatedAt: C.now(),
          };
          await tx.put('trips', trip.tripId, row);
          await emit(tx, 'trip.canceled', trip.tripId, row.version, {
            ...payload(trip),
            reason: row.reason,
            canceledAt: row.canceledAt,
          });
        }
      }
      const updated = await get(trip.tripId, tx),
        result = {
          tripId: trip.tripId,
          assignmentId: trip.assignmentId,
          status: updated.status,
          activated: updated.activated,
        };
      await tx.create('operations', key, { requestHash, result });
      await C.audit(tx, `trip.${action}`, trip.tripId);
      return result;
    });
  }
  const actions = {
    getCustomerDriverAccess: async (input) => {
      C.demand(
        input.actor?.role === 'CUSTOMER' && input.actor.customerId,
        403,
        'FORBIDDEN',
        'Customer actor required',
      );
      const trips = await repository.list('trips', {
        customerId: input.actor.customerId,
        driverId: input.params.id,
        activated: true,
      });
      return { allowed: trips.some((trip) => trip.status !== 'CANCELED') };
    },
    createTrip: (input) =>
      repository.tx(async (tx) => {
        C.demand(
          !(await tx.get('tombstones', input.body.tripId)),
          409,
          'ASSIGNMENT_CANCELED',
          'Assignment has been compensated',
        );
        const requestHash = C.hash(input.body),
          existing = (await tx.list('trips', { assignmentId: input.body.assignmentId }))[0];
        if (existing) {
          C.demand(
            existing.requestHash === requestHash,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Assignment reused with different data',
          );
          return {
            tripId: existing.tripId,
            assignmentId: existing.assignmentId,
            status: existing.status,
            activated: existing.activated,
          };
        }
        const rules = (await tx.list('pricing', { vehicleTypeId: input.body.vehicleTypeId })).sort(
          (a, b) => b.version - a.version || a.pricingRuleId.localeCompare(b.pricingRuleId),
        );
        C.demand(
          rules.length,
          409,
          'PRICING_RULE_MISSING',
          'No effective pricing rule is configured',
        );
        const trip = {
          ...input.body,
          requestHash,
          status: 'ASSIGNED',
          activated: false,
          paymentStatus: 'UNPAID',
          pricingSnapshot: rules[0],
          distanceKm: 0,
          durationMinutes: 0,
          version: 1,
          createdAt: C.now(),
          updatedAt: C.now(),
        };
        await tx.create('trips', trip.tripId, trip);
        await C.audit(tx, 'trip.created', trip.tripId);
        return {
          tripId: trip.tripId,
          assignmentId: trip.assignmentId,
          status: trip.status,
          activated: false,
        };
      }),
    getTripByAssignment: async (input) => {
      const trip = (await repository.list('trips', { assignmentId: input.params.assignmentId }))[0];
      C.demand(trip, 404, 'NOT_FOUND', 'Assignment not found');
      return {
        tripId: trip.tripId,
        assignmentId: trip.assignmentId,
        status: trip.status,
        activated: trip.activated,
      };
    },
    activateTrip: (input) => operation(input, 'activate'),
    cancelTrip: (input) => operation(input, 'cancel'),
    updateTripStatus: (input) =>
      repository.tx(async (tx) => {
        const trip = await get(input.params.id, tx);
        C.owner(input.user, 'driver', trip.driverId, false);
        C.demand(trip.activated, 409, 'ASSIGNMENT_INCOMPLETE', 'Assignment not activated');
        C.demand(
          transitions[trip.status]?.includes(input.body.status),
          409,
          'INVALID_STATUS_TRANSITION',
          'Invalid Trip transition',
        );
        const row = {
          ...trip,
          status: input.body.status,
          updatedAt: C.now(),
          version: trip.version + 1,
        };
        if (row.status === 'IN_PROGRESS') row.startedAt = C.now();
        if (row.status === 'COMPLETED') {
          row.completedAt = C.now();
          row.durationMinutes = 0;
          try {
            row.fare = calculateFare(row);
            row.fareStatus = 'READY';
          } catch (error) {
            if (error.status !== 409) throw error;
            row.fareStatus = 'PENDING';
            row.fareError = error.code;
          }
          await emit(tx, 'trip.completed', trip.tripId, row.version, {
            ...payload(trip),
            completedAt: row.completedAt,
          });
        }
        if (row.status === 'DRIVER_ARRIVED')
          await emit(tx, 'driver.arrived', trip.tripId, row.version, payload(trip));
        await tx.put('trips', row.tripId, row);
        await C.audit(tx, 'trip.status', row.tripId);
        return { tripId: row.tripId, status: row.status };
      }),
    recordTripLocation: async (input) => {
      const trip = await get(input.params.id);
      C.owner(input.user, 'driver', trip.driverId, false);
      C.demand(trip.activated && !['COMPLETED', 'CANCELED'].includes(trip.status));
      const sampleId = C.hash({ tripId: trip.tripId, ...input.body });
      const sample = await C.ipc('driver', `/api/v1/internal-drivers/${trip.driverId}/locations`, {
        method: 'POST',
        body: { sampleId, tripId: trip.tripId, ...input.body },
      });
      await repository.tx(async (tx) => {
        const current = await get(trip.tripId, tx);
        C.demand(current.activated && !['COMPLETED', 'CANCELED'].includes(current.status));
        if (await tx.get('locationSamples', sampleId)) return;
        const extra =
          current.status === 'IN_PROGRESS' && current.lastSample
            ? distance(current.lastSample, input.body)
            : 0;
        await tx.create('locationSamples', sampleId, { sampleId, tripId: trip.tripId });
        await tx.put('trips', trip.tripId, {
          ...current,
          distanceKm: current.distanceKm + extra,
          lastSample: input.body,
          updatedAt: C.now(),
        });
      });
      return { locationId: sample.locationId };
    },
    getTrip: async (input) => {
      const trip = await get(input.params.id);
      canView(input.user, trip);
      const location = await C.ipc('driver', `/api/v1/internal-drivers/${trip.driverId}/locations/latest`, {
        user: input.user,
      });
      const { requestHash, pricingSnapshot, lastSample, ...result } = trip;
      return {
        ...result,
        review: (await repository.get('ratings', trip.tripId)) || null,
        driver: location.driver,
        vehicle: location.driver.vehicle,
        latestLocation: location.latestLocation,
        locationAvailable: location.available,
      };
    },
    getFare: async (input) => {
      const trip = await get(input.params.id);
      canView(input.user, trip);
      C.demand(
        trip.status === 'COMPLETED' && trip.fare,
        409,
        'FARE_NOT_READY',
        'Final Fare is unavailable',
      );
      return trip.fare;
    },
    createReview: (input) =>
      repository.tx(async (tx) => {
        const trip = await get(input.params.id, tx);
        C.owner(input.user, 'customer', trip.customerId, false);
        C.demand(trip.status === 'COMPLETED');
        C.demand(
          !(await tx.get('ratings', trip.tripId)),
          409,
          'REVIEW_ALREADY_EXISTS',
          'Trip already reviewed',
        );
        const row = {
          ratingId: C.id(),
          tripId: trip.tripId,
          customerId: trip.customerId,
          driverId: trip.driverId,
          score: input.body.score,
          comment: input.body.comment || '',
          createdAt: C.now(),
        };
        await tx.create('ratings', trip.tripId, row);
        await C.audit(tx, 'trip.reviewed', trip.tripId);
        return row;
      }),
    getPaymentContext: async (input) => {
      const trip = await get(input.params.id);
      C.owner(input.actor, 'customer', trip.customerId, false);
      C.demand(
        trip.status === 'COMPLETED' && trip.fare,
        409,
        'FARE_NOT_READY',
        'Completed Trip and Fare required',
      );
      return {
        tripId: trip.tripId,
        customerId: trip.customerId,
        userId: input.actor.userId,
        status: trip.status,
        paymentStatus: trip.paymentStatus,
        fare: trip.fare,
      };
    },
  };
  return {
    actions,
    subscriptions: [
      {
        group: 'trip.payment-status',
        topics: ['cab.payment.events'],
        handler: async (tx, event) => {
          if (event.eventType !== 'payment.completed') return;
          const trip = await get(event.payload.tripId, tx);
          C.demand(
            trip.customerId === event.payload.customerId &&
              trip.fare?.totalAmount === event.payload.amount &&
              trip.fare.currency === event.payload.currency,
          );
          if (trip.paymentStatus !== 'PAID')
            await tx.put('trips', trip.tripId, {
              ...trip,
              paymentStatus: 'PAID',
              updatedAt: C.now(),
            });
        },
      },
    ],
    async tick() {
      for (const candidate of await repository.list('trips', { fareStatus: 'PENDING' })) {
        await repository.tx(async (tx) => {
          const current = await get(candidate.tripId, tx);
          if (current.status !== 'COMPLETED' || current.fare || current.paymentStatus === 'PAID')
            return;
          try {
            const fare = calculateFare(current);
            await tx.put('trips', current.tripId, {
              ...current,
              fare,
              fareStatus: 'READY',
              fareError: null,
              updatedAt: C.now(),
            });
            await C.audit(tx, 'trip.fare.reconciled', current.tripId);
          } catch (error) {
            if (error.status !== 409) throw error;
          }
        });
      }
    },
  };
};
module.exports.distance = distance;
