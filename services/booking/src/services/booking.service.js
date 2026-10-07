'use strict';
const C = require('../../../../shared/lib/core');
const { emit } = require('../../../../shared/lib/events');
module.exports = (repository) => {
  async function get(id, tx = repository) {
    const row = await tx.get('bookings', id);
    C.demand(row, 404, 'NOT_FOUND', 'Booking not found');
    return row;
  }
  async function offer(id, user, tx = repository) {
    const row = await tx.get('offers', id);
    C.demand(row, 404, 'NOT_FOUND', 'Offer not found');
    C.owner(user, 'driver', row.driverId, false);
    return row;
  }
  async function dispatch(bookingId) {
    const booking = await get(bookingId);
    if (booking.status !== 'SEARCHING_DRIVER' || booking.assignmentId) return;
    const offers = await repository.list('offers', { bookingId });
    if (offers.some((o) => o.status === 'PENDING')) return;
    const query = new URLSearchParams({
      lat: booking.pickup.lat,
      lng: booking.pickup.lng,
      radiusKm: '1',
      vehicleTypeId: booking.vehicleTypeId,
      page: '1',
      limit: '100',
    });
    const candidates = await C.ipc('driver', `/api/v1/internal-drivers?${query}`);
    await repository.tx(async (tx) => {
      const current = await get(bookingId, tx);
      if (current.status !== 'SEARCHING_DRIVER' || current.assignmentId) return;
      const existing = await tx.list('offers', { bookingId });
      if (existing.some((o) => o.status === 'PENDING')) return;
      const candidate = candidates.items.find(
        (d) => !existing.some((o) => o.driverId === d.driverId),
      );
      if (!candidate) {
        const row = {
          ...current,
          status: 'NO_DRIVER_FOUND',
          version: current.version + 1,
          updatedAt: C.now(),
        };
        await tx.put('bookings', bookingId, row);
        await emit(tx, 'booking.no-driver-found', bookingId, row.version, {
          bookingId,
          customerId: row.customerId,
        });
        return;
      }
      const offerId = C.id(),
        row = {
          offerId,
          bookingId,
          driverId: candidate.driverId,
          driverUserId: candidate.userId,
          vehicleId: candidate.vehicle.vehicleId,
          status: 'PENDING',
          expiresAt: null,
          createdAt: C.now(),
          pickup: current.pickup,
          destination: current.destination,
          vehicleTypeId: current.vehicleTypeId,
        };
      await tx.create('offers', offerId, row);
      await tx.put('bookings', bookingId, { ...current, version: current.version + 1 });
      await emit(tx, 'offer.created', bookingId, current.version + 1, {
        bookingId,
        customerId: current.customerId,
        offerId,
        driverId: row.driverId,
        expiresAt: row.expiresAt,
      });
    });
  }
  async function step(workflowId, fields) {
    return repository.tx(async (tx) => {
      const row = await tx.get('assignments', workflowId);
      return tx.put('assignments', workflowId, { ...row, ...fields });
    });
  }
  async function assign(workflow) {
    const booking = await get(workflow.bookingId);
    if (workflow.status === 'COMPLETED') return workflow.result;
    if (workflow.status === 'COMPENSATING') {
      await compensate(workflow);
      C.fail(409, 'ASSIGNMENT_FAILED', 'Assignment could not be completed');
    }
    if (workflow.status === 'FAILED')
      C.fail(409, 'ASSIGNMENT_FAILED', 'Assignment could not be completed');
    const reference = {
      assignmentId: workflow.assignmentId,
      bookingId: workflow.bookingId,
      tripId: workflow.tripId,
    };
    if (!workflow.reserved) {
      try {
        await C.ipc('driver', `/api/v1/internal-drivers/${workflow.driverId}/reservations`, {
          method: 'PUT',
          body: reference,
        });
      } catch (error) {
        if (error.status === 409)
          await repository.tx(async (tx) => {
            const row = await get(booking.bookingId, tx),
              o = await tx.get('offers', workflow.offerId);
            if (row.assignmentId !== workflow.assignmentId) return;
            await tx.put('assignments', workflow.assignmentId, { ...workflow, status: 'FAILED' });
            await tx.put('bookings', row.bookingId, { ...row, assignmentId: null });
            await tx.put('offers', o.offerId, { ...o, status: 'REJECTED' });
          });
        throw error;
      }
      workflow = await step(workflow.assignmentId, { reserved: true });
    }
    if (!workflow.tripCreated) {
      try {
        await C.ipc('trip', '/api/v1/internal-trips', {
          method: 'POST',
          body: {
            ...reference,
            customerId: booking.customerId,
            driverId: workflow.driverId,
            vehicleId: workflow.vehicleId,
            vehicleTypeId: booking.vehicleTypeId,
            pickup: booking.pickup,
            destination: booking.destination,
          },
        });
      } catch (error) {
        if ([400, 409].includes(error.status)) {
          const row = await step(workflow.assignmentId, { status: 'COMPENSATING' });
          await compensate(row);
        }
        throw error;
      }
      workflow = await step(workflow.assignmentId, { tripCreated: true });
    }
    if (!workflow.confirmed) {
      await C.ipc('driver', `/api/v1/internal-drivers/${workflow.driverId}/reservations/confirmations`, {
        method: 'POST',
        body: { assignmentId: workflow.assignmentId, tripId: workflow.tripId },
      });
      workflow = await step(workflow.assignmentId, { confirmed: true });
    }
    await repository.tx(async (tx) => {
      const row = await get(workflow.bookingId, tx);
      C.demand(row.assignmentId === workflow.assignmentId);
      if (row.status === 'SEARCHING_DRIVER')
        await tx.put('bookings', row.bookingId, {
          ...row,
          status: 'DRIVER_ASSIGNED',
          assignedDriverId: workflow.driverId,
          tripId: workflow.tripId,
          updatedAt: C.now(),
          version: row.version + 1,
        });
      const o = await tx.get('offers', workflow.offerId);
      await tx.put('offers', o.offerId, { ...o, status: 'ACCEPTED' });
      for (const other of await tx.list('offers', {
        bookingId: workflow.bookingId,
        status: 'PENDING',
      }))
        if (other.offerId !== o.offerId)
          await tx.put('offers', other.offerId, { ...other, status: 'CANCELED' });
    });
    await C.ipc('trip', `/api/v1/internal-trips/${workflow.tripId}/activations`, {
      method: 'POST',
      body: {
        assignmentId: workflow.assignmentId,
        operationId: `activate:${workflow.assignmentId}`,
      },
    });
    const result = {
      tripId: workflow.tripId,
      bookingId: workflow.bookingId,
      driverId: workflow.driverId,
      status: 'ASSIGNED',
    };
    await step(workflow.assignmentId, { status: 'COMPLETED', result });
    return result;
  }
  async function compensate(workflow) {
    // A tombstone in Trip atomically fences even a late create after a timeout.
    await C.ipc('trip', `/api/v1/internal-trips/${workflow.tripId}/cancellations`, {
      method: 'POST',
      body: {
        assignmentId: workflow.assignmentId,
        operationId: `compensate:${workflow.assignmentId}`,
        reason: 'Assignment could not be completed',
      },
    });
    await C.ipc('driver', `/api/v1/internal-drivers/${workflow.driverId}/reservations/releases`, {
      method: 'POST',
      body: { assignmentId: workflow.assignmentId, tripId: workflow.tripId },
    });
    await repository.tx(async (tx) => {
      const row = await get(workflow.bookingId, tx),
        o = await tx.get('offers', workflow.offerId);
      C.demand(row.assignmentId === workflow.assignmentId);
      await tx.put('assignments', workflow.assignmentId, { ...workflow, status: 'FAILED' });
      await tx.put('bookings', row.bookingId, { ...row, assignmentId: null });
      await tx.put('offers', o.offerId, { ...o, status: 'REJECTED' });
    });
  }
  async function cancel(workflow) {
    const booking = await get(workflow.bookingId);
    if (workflow.status === 'COMPLETED') return workflow.result;
    if (booking.tripId)
      await C.ipc('trip', `/api/v1/internal-trips/${booking.tripId}/cancellations`, {
        method: 'POST',
        body: {
          assignmentId: booking.assignmentId,
          operationId: workflow.operationId,
          reason: workflow.reason,
        },
      });
    return repository.tx(async (tx) => {
      const current = await get(booking.bookingId, tx);
      // A Trip completion event wins if cancellation could not commit in the Trip owner.
      C.demand(current.status !== 'COMPLETED');
      if (current.status !== 'CANCELED') {
        const row = {
          ...current,
          status: 'CANCELED',
          cancellationReason: workflow.reason,
          canceledAt: C.now(),
          updatedAt: C.now(),
          version: current.version + 1,
        };
        await tx.put('bookings', row.bookingId, row);
        for (const o of await tx.list('offers', { bookingId: row.bookingId, status: 'PENDING' }))
          await tx.put('offers', o.offerId, { ...o, status: 'CANCELED' });
        await emit(tx, 'booking.canceled', row.bookingId, row.version, {
          bookingId: row.bookingId,
          customerId: row.customerId,
          reason: workflow.reason,
        });
      }
      const result = {
        bookingId: booking.bookingId,
        status: 'CANCELED',
        ...(booking.tripId ? { tripId: booking.tripId, tripStatus: 'CANCELED' } : {}),
      };
      await tx.put('cancellations', workflow.operationId, {
        ...workflow,
        status: 'COMPLETED',
        result,
      });
      await C.audit(tx, 'booking.canceled', booking.bookingId, workflow.actorUserId);
      return result;
    });
  }
  const actions = {
    createBooking: async (input) => {
      const customer = await C.ipc(
        'customer',
        `/api/v1/internal-customers/${encodeURIComponent(input.user.customerId || '')}`,
      );
      C.demand(customer.userId === input.user.userId, 403, 'FORBIDDEN', 'Invalid Customer context');
      C.demand(
        ['VT-4SEATS', 'VT-7SEATS'].includes(input.body.vehicleTypeId),
        400,
        'VALIDATION_ERROR',
        'Unknown vehicle type',
      );
      return repository.tx(async (tx) => {
        const bookingId = C.id(),
          row = {
            ...input.body,
            bookingId,
            customerId: customer.customerId,
            status: 'SEARCHING_DRIVER',
            version: 1,
            createdAt: C.now(),
            updatedAt: C.now(),
          };
        await tx.create('bookings', bookingId, row);
        await emit(tx, 'booking.created', bookingId, 1, { bookingId, customerId: row.customerId });
        await C.audit(tx, 'booking.created', bookingId);
        return { bookingId, status: row.status };
      });
    },
    listCustomerBookings: async (input) => {
      const customer = await C.ipc(
        'customer',
        `/api/v1/internal-customers/${encodeURIComponent(input.params.id)}`,
      );
      C.demand(
        ['ADMIN', 'OPERATOR'].includes(input.user.role) || input.user.userId === customer.userId,
        403,
        'FORBIDDEN',
        'Booking list belongs to another user',
      );
      const rows = await repository.list('bookings', {
        customerId: input.params.id,
        ...(input.query.status ? { status: input.query.status } : {}),
      });
      return C.paginate(
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        input.query,
      );
    },
    listDriverOffers: async (input) =>
      C.paginate(
        await repository.list('offers', { driverId: input.user.driverId, status: 'PENDING' }),
        input.query,
      ),
    acceptOffer: async (input) => {
      const workflow = await repository.tx(async (tx) => {
        const o = await offer(input.params.id, input.user, tx),
          booking = await get(o.bookingId, tx);
        if (booking.assignmentId) {
          const existing = await tx.get('assignments', booking.assignmentId);
          C.demand(
            existing.offerId === o.offerId,
            409,
            'OFFER_PROCESSED',
            'Another offer has claimed this Booking',
          );
          return existing;
        }
        C.demand(
          o.status === 'PENDING' && booking.status === 'SEARCHING_DRIVER',
          409,
          'OFFER_PROCESSED',
          'Offer is processed',
        );
        const row = {
          assignmentId: C.id(),
          tripId: C.id(),
          bookingId: booking.bookingId,
          offerId: o.offerId,
          driverId: o.driverId,
          vehicleId: o.vehicleId,
          status: 'PENDING',
          createdAt: C.now(),
        };
        await tx.create('assignments', row.assignmentId, row);
        await tx.put('bookings', booking.bookingId, { ...booking, assignmentId: row.assignmentId });
        await C.audit(tx, 'assignment.claimed', row.assignmentId);
        return row;
      });
      return assign(workflow);
    },
    rejectOffer: (input) =>
      repository.tx(async (tx) => {
        const o = await offer(input.params.id, input.user, tx),
          booking = await get(o.bookingId, tx);
        C.demand(o.status === 'PENDING' && !booking.assignmentId);
        await tx.put('offers', o.offerId, { ...o, status: 'REJECTED' });
        return { offerId: o.offerId, status: 'REJECTED' };
      }),
    cancelBooking: async (input) => {
      const workflow = await repository.tx(async (tx) => {
        const booking = await get(input.params.id, tx);
        C.owner(input.user, 'customer', booking.customerId, false);
        if (booking.assignmentId) {
          const assignment = await tx.get('assignments', booking.assignmentId);
          C.demand(
            assignment?.status === 'COMPLETED',
            409,
            'ASSIGNMENT_IN_PROGRESS',
            'Retry cancellation after assignment resolves',
          );
        }
        const operationId = `cancel:${booking.bookingId}`,
          previous = await tx.get('cancellations', operationId);
        if (previous) {
          C.demand(
            previous.reason === input.body.reason,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Cancellation reason differs',
          );
          C.demand(
            previous.status !== 'REJECTED',
            409,
            'TRIP_ALREADY_IN_PROGRESS',
            'Cancellation was rejected by Trip',
          );
          return previous;
        }
        C.demand(!['COMPLETED', 'NO_DRIVER_FOUND'].includes(booking.status));
        const row = {
          operationId,
          bookingId: booking.bookingId,
          actorUserId: input.user.userId,
          reason: input.body.reason,
          status: 'PENDING',
          createdAt: C.now(),
        };
        await tx.create('cancellations', operationId, row);
        return row;
      });
      try {
        return await cancel(workflow);
      } catch (e) {
        if (e.status === 409)
          await repository.tx(async (tx) => {
            const row = await tx.get('cancellations', workflow.operationId);
            await tx.put('cancellations', row.operationId, { ...row, status: 'REJECTED' });
          });
        throw e;
      }
    },
    getOfferDeliveryContext: async (input) => {
      const o = await repository.get('offers', input.params.id);
      C.demand(o, 404, 'NOT_FOUND', 'Offer not found');
      const booking = await get(o.bookingId);
      return {
        offerId: o.offerId,
        bookingId: o.bookingId,
        driverId: o.driverId,
        recipientUserId: o.driverUserId,
        recipientId: o.driverId,
        customerId: booking.customerId,
        status: o.status,
        expiresAt: o.expiresAt,
        deliverable: o.status === 'PENDING' && booking.status === 'SEARCHING_DRIVER',
      };
    },
  };
  return {
    actions,
    subscriptions: [
      {
        group: 'booking.matching',
        topics: ['cab.booking.events'],
        handler: async (tx, event) => {
          if (event.eventType === 'booking.created')
            await tx.put('dispatch', event.payload.bookingId, {
              bookingId: event.payload.bookingId,
            });
        },
      },
      {
        group: 'booking.trip-status',
        topics: ['cab.trip.events'],
        handler: async (tx, event) => {
          if (!['trip.completed', 'trip.canceled'].includes(event.eventType)) return;
          const row = await tx.get('bookings', event.payload.bookingId);
          if (
            !row ||
            row.assignmentId !== event.payload.assignmentId ||
            ['COMPLETED', 'CANCELED'].includes(row.status)
          )
            return;
          await tx.put('bookings', row.bookingId, {
            ...row,
            status: event.eventType === 'trip.completed' ? 'COMPLETED' : 'CANCELED',
            updatedAt: C.now(),
          });
        },
      },
    ],
    async tick() {
      for (const row of await repository.list('assignments', { status: 'PENDING' })) {
        try {
          await assign(row);
        } catch (_) {}
      }
      for (const row of await repository.list('assignments', { status: 'COMPENSATING' })) {
        try {
          await compensate(row);
        } catch (_) {}
      }
      for (const row of await repository.list('cancellations', { status: 'PENDING' })) {
        try {
          await cancel(row);
        } catch (e) {
          if (e.status === 409)
            await repository.tx((tx) =>
              tx.put('cancellations', row.operationId, { ...row, status: 'REJECTED' }),
            );
        }
      }
      for (const job of await repository.list('dispatch')) {
        try {
          await dispatch(job.bookingId);
          const row = await get(job.bookingId);
          if (row.status !== 'SEARCHING_DRIVER')
            await repository.tx((tx) => tx.remove('dispatch', job.bookingId));
        } catch (_) {}
      }
    },
  };
};
