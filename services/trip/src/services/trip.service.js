'use strict';
const C = require('../../../../shared/lib/core');
const { emit } = require('../../../../shared/lib/events');
function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}
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
function routeDistance(pickup, destination) {
  for (const point of [pickup, destination])
    C.demand(
      point &&
        Number.isFinite(point.lat) &&
        Math.abs(point.lat) <= 90 &&
        Number.isFinite(point.lng) &&
        Math.abs(point.lng) <= 180,
      400,
      'VALIDATION_ERROR',
      'Valid pickup and destination coordinates are required',
    );
  const km = distance(
    { latitude: pickup.lat, longitude: pickup.lng },
    { latitude: destination.lat, longitude: destination.lng },
  );
  // Six decimal places in km; a positive route must not round down to zero.
  return km === 0 ? 0 : Math.max(0.000001, Math.round(km * 1e6) / 1e6);
}
const payableStatuses = [
  'ASSIGNED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'PICKED_UP',
  'IN_PROGRESS',
  'COMPLETED',
];
module.exports = (repository) => {
  function calculateFare(trip) {
    C.demand(
      Number.isFinite(trip.distanceKm) &&
        trip.distanceKm >= 0 &&
        Number.isFinite(trip.durationMinutes) &&
        trip.durationMinutes >= 0 &&
        trip.pricingSnapshot,
      409,
      'METRICS_MISSING',
      'Route distance or pricing snapshot require reconciliation',
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
      timeFare = Math.round(trip.durationMinutes * rule.perMinuteRate);
    C.demand(
      Number.isSafeInteger(rule.baseFare + distanceFare + timeFare),
      409,
      'PRICING_INVALID',
      'Fare must be a safe integer amount in VND',
    );
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
  async function quote(trip, tx) {
    // Preserve all existing fares, especially paid legacy trips. No bulk migration.
    if (trip.fare || trip.paymentStatus === 'PAID' || trip.status === 'CANCELED') return trip;
    const rules = trip.pricingSnapshot
      ? [trip.pricingSnapshot]
      : (await tx.list('pricing', { vehicleTypeId: trip.vehicleTypeId })).sort(
          (a, b) => b.version - a.version || a.pricingRuleId.localeCompare(b.pricingRuleId),
        );
    C.demand(rules.length, 409, 'PRICING_RULE_MISSING', 'No effective pricing rule is configured');
    const row = {
      ...trip,
      pricingSnapshot: rules[0],
      distanceKm: routeDistance(trip.pickup, trip.destination),
      durationMinutes: 0,
      fareStatus: 'READY',
      fareError: null,
    };
    row.fare = calculateFare(row);
    return row;
  }
  async function readyTrip(id, tx) {
    const trip = await get(id, tx),
      row = await quote(trip, tx);
    if (row !== trip) {
      await tx.put('trips', id, { ...row, updatedAt: C.now() });
      await C.audit(tx, 'trip.fare.reconciled', id);
    }
    return row;
  }
  function fareReady(trip) {
    // Old seed/completed trips have a fare but no fareStatus field.
    return !!trip.fare && (trip.fareStatus === 'READY' || trip.fareStatus === undefined);
  }
  function requirePayable(trip) {
    C.demand(
      trip.activated && payableStatuses.includes(trip.status) && fareReady(trip),
      409,
      'FARE_NOT_READY',
      'Activated, non-canceled Trip with ready Fare required',
    );
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
          trip.paymentStatus !== 'PAID',
          409,
          'TRIP_ALREADY_PAID',
          'Cannot cancel a paid Trip; refunds are not supported',
        );
        C.demand(
          !trip.paymentReservation,
          409,
          'PAYMENT_IN_PROGRESS',
          'Cannot cancel while payment is processing; wait for its final result',
        );
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
        const trip = await quote(
          {
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
          },
          tx,
        );
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
          // New trips already have a frozen fare. Reconcile only legacy unpaid trips.
          try {
            Object.assign(row, await quote(row, tx));
          } catch (error) {
            if (![400, 409].includes(error.status)) throw error;
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
          trackedDistanceKm: (current.trackedDistanceKm || 0) + extra,
          lastSample: input.body,
          updatedAt: C.now(),
        });
      });
      return { locationId: sample.locationId };
    },
    getTrip: async (input) => {
      const trip = await repository.tx(async (tx) => {
        const existing = await get(input.params.id, tx);
        canView(input.user, existing);
        // Reads still work for old incomplete fixtures with missing pricing/coordinates.
        try {
          return await readyTrip(existing.tripId, tx);
        } catch (error) {
          if (![400, 409].includes(error.status)) throw error;
          return existing;
        }
      });
      const location = await C.ipc(
        'driver',
        `/api/v1/internal-drivers/${trip.driverId}/locations/latest`,
        {
          user: input.user,
        },
      );
      const { requestHash, pricingSnapshot, lastSample, paymentReservation, ...result } = trip;
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
      const trip = await repository.tx(async (tx) => {
        canView(input.user, await get(input.params.id, tx));
        return readyTrip(input.params.id, tx);
      });
      C.demand(
        trip.status !== 'CANCELED' && fareReady(trip),
        409,
        'FARE_NOT_READY',
        'Fare is unavailable for this Trip',
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
          comment: escapeHtml(input.body.comment || ''),
          createdAt: C.now(),
        };
        await tx.create('ratings', trip.tripId, row);
        await C.audit(tx, 'trip.reviewed', trip.tripId);
        return row;
      }),
    updateReview: (input) =>
      repository.tx(async (tx) => {
        const trip = await get(input.params.id, tx);
        C.owner(input.user, 'customer', trip.customerId, false);
        C.demand(trip.status === 'COMPLETED');
        const previous = await tx.get('ratings', trip.tripId);
        C.demand(previous, 404, 'NOT_FOUND', 'Review not found');
        const row = {
          ...previous,
          ...(input.body.score !== undefined ? { score: input.body.score } : {}),
          ...(input.body.comment !== undefined
            ? { comment: escapeHtml(input.body.comment) }
            : {}),
          updatedAt: C.now(),
        };
        await tx.put('ratings', trip.tripId, row);
        await C.audit(tx, 'trip.review.updated', trip.tripId);
        return row;
      }),
    getPaymentContext: async (input) => {
      const trip = await repository.tx(async (tx) => {
        C.owner(input.actor, 'customer', (await get(input.params.id, tx)).customerId, false);
        return readyTrip(input.params.id, tx);
      });
      requirePayable(trip);
      return {
        tripId: trip.tripId,
        customerId: trip.customerId,
        userId: input.actor.userId,
        status: trip.status,
        activated: trip.activated,
        fareStatus: 'READY',
        paymentStatus: trip.paymentStatus,
        fare: trip.fare,
      };
    },
    authorizePayment: (input) =>
      repository.tx(async (tx) => {
        const trip = await get(input.params.id, tx);
        requirePayable(trip);
        C.demand(
          trip.tripId === input.body.tripId &&
            trip.customerId === input.body.customerId &&
            trip.fare.fareId === input.body.fareId &&
            trip.fare.totalAmount === input.body.amount &&
            trip.fare.currency === input.body.currency,
          409,
          'PAYMENT_CONTEXT_CHANGED',
          'Payment does not match the frozen Fare',
        );
        const previous = trip.paymentReservation;
        if (previous) {
          C.demand(
            previous.paymentId === input.body.paymentId,
            409,
            'TRIP_PAYMENT_EXISTS',
            'Another payment is already authorized',
          );
          return { ack: true };
        }
        C.demand(trip.paymentStatus !== 'PAID', 409, 'TRIP_ALREADY_PAID', 'Trip is already paid');
        await tx.put('trips', trip.tripId, {
          ...trip,
          paymentReservation: { paymentId: input.body.paymentId },
          updatedAt: C.now(),
        });
        return { ack: true };
      }),
  };
  return {
    actions,
    subscriptions: [
      {
        group: 'trip.payment-status',
        topics: ['cab.payment.events'],
        handler: async (tx, event) => {
          if (!['payment.completed', 'payment.failed'].includes(event.eventType)) return;
          const trip = await get(event.payload.tripId, tx);
          C.demand(
            trip.customerId === event.payload.customerId &&
              trip.fare?.totalAmount === event.payload.amount &&
              trip.fare.currency === event.payload.currency,
          );
          if (event.eventType === 'payment.failed') {
            if (trip.paymentReservation?.paymentId === event.payload.paymentId)
              await tx.put('trips', trip.tripId, {
                ...trip,
                paymentReservation: null,
                updatedAt: C.now(),
              });
            return;
          }
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
            await readyTrip(current.tripId, tx);
          } catch (error) {
            if (![400, 409].includes(error.status)) throw error;
          }
        });
      }
    },
  };
};
module.exports.distance = distance;
