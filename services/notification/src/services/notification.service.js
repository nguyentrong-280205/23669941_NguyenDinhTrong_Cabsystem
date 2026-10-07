'use strict';
const C = require('../../../../shared/lib/core');
module.exports = (repository) => {
  async function handle(tx, event) {
    if (event.eventType === 'booking.created' || event.eventType === 'payment.processing') return;
    const p = event.payload;
    let recipientId = p.recipientId || p.customerId || p.userId,
      type = 'IN_APP',
      encryptedPayload;
    if (event.eventType === 'otp.requested') {
      recipientId = p.challengeId;
      type = 'OTP';
      encryptedPayload = p.encryptedPayload;
    }
    if (event.eventType === 'offer.created') recipientId = p.driverId;
    C.demand(recipientId, 400, 'INVALID_EVENT', 'Recipient is missing');
    const notificationId = `${event.eventId}:${recipientId}`;
    const notification = {
      notificationId,
      recipientId,
      userId: p.recipientUserId || recipientId,
      eventId: event.eventId,
      eventType: event.eventType,
      type: event.eventType,
      channel: 'IN_APP',
      title: event.eventType,
      content: event.eventType,
      status: 'PENDING',
      referenceType: event.eventType.split('.')[0].toUpperCase(),
      referenceId: p.tripId || p.bookingId || p.driverId || p.challengeId,
      readAt: null,
      createdAt: C.now(),
    };
    if (type !== 'OTP') await tx.create('notifications', notificationId, notification);
    await tx.create('deliveries', notificationId, {
      notificationId,
      recipientId,
      type,
      eventType: event.eventType,
      payload: p,
      encryptedPayload: encryptedPayload || null,
      attempts: 0,
      status: 'PENDING',
      nextAt: C.now(),
      createdAt: C.now(),
    });
  }
  async function deliver(job) {
    if (job.eventType === 'offer.created') {
      const current = await C.ipc(
        'booking',
        `/api/v1/internal-offers/${job.payload.offerId}/delivery-contexts`,
      );
      if (!current.deliverable) {
        await finish(job, 'SKIPPED');
        return;
      }
    }
    C.demand(
      process.env.NOTIFICATION_PROVIDER_URL,
      500,
      'CONFIGURATION_ERROR',
      'Notification provider not configured',
    );
    const privatePayload =
      job.type === 'OTP'
        ? C.decrypt(job.encryptedPayload)
        : { recipientId: job.recipientId, eventType: job.eventType, body: job.eventType };
    const response = await fetch(`${process.env.NOTIFICATION_PROVIDER_URL}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${C.secret('NOTIFICATION_PROVIDER_SECRET')}`,
        'idempotency-key': job.notificationId,
      },
      body: JSON.stringify(privatePayload),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      const error = new Error('Delivery failed');
      error.permanent = [400, 401, 403, 404].includes(response.status);
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      throw error;
    }
    await finish(job, 'SENT');
  }
  async function finish(job, status) {
    await repository.tx(async (tx) => {
      const current = await tx.get('deliveries', job.notificationId);
      await tx.put('deliveries', job.notificationId, {
        ...current,
        status,
        encryptedPayload: null,
        sentAt: C.now(),
      });
      const notification = await tx.get('notifications', job.notificationId);
      if (notification)
        await tx.put('notifications', job.notificationId, {
          ...notification,
          status: status === 'SKIPPED' ? 'EXPIRED' : status,
        });
    });
  }
  const actions = {
    listNotifications: async (input) => {
      const recipientIds = [input.user.userId, input.user.customerId, input.user.driverId].filter(
        Boolean,
      );
      const rows = (await repository.list('notifications')).filter((row) =>
        recipientIds.includes(row.recipientId),
      );
      return C.paginate(
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        input.query,
      );
    },
    markNotificationRead: (input) =>
      repository.tx(async (tx) => {
        const row = await tx.get('notifications', input.params.id);
        C.demand(row, 404, 'NOT_FOUND', 'Notification not found');
        C.demand(
          [input.user.userId, input.user.customerId, input.user.driverId].includes(row.recipientId),
          403,
          'FORBIDDEN',
          'Notification belongs to another user',
        );
        await tx.put('notifications', row.notificationId, { ...row, readAt: C.now() });
        return { notificationId: row.notificationId, isRead: true };
      }),
  };
  return {
    actions,
    subscriptions: [
      {
        group: 'notification.events',
        topics: [
          'cab.booking.events',
          'cab.trip.events',
          'cab.payment.events',
          'cab.driver.events',
        ],
        handler: handle,
        prepare: async (event) => {
          if (['booking.created', 'payment.processing'].includes(event.eventType)) return event;
          const p = event.payload;
          if (event.eventType === 'offer.created') {
            const delivery = await C.ipc(
              'booking',
              `/api/v1/internal-offers/${p.offerId}/delivery-contexts`,
            );
            return {
              ...event,
              payload: { ...p, recipientId: p.driverId, recipientUserId: delivery.recipientUserId },
            };
          }
          if (p.userId) return { ...event, payload: { ...p, recipientUserId: p.userId } };
          const customer = await C.ipc('customer', `/api/v1/internal-customers/${p.customerId}`);
          return { ...event, payload: { ...p, recipientUserId: customer.userId } };
        },
      },
      { group: 'notification.otp', topics: ['cab.identity.otp'], handler: handle },
    ],
    async tick() {
      const jobs = (await repository.list('deliveries')).filter(
        (j) =>
          j.status === 'PENDING' ||
          (j.status === 'PROCESSING' && Date.now() - Date.parse(j.claimedAt) > 30000),
      );
      for (const job of jobs) {
        const claimed = await repository.tx(async (tx) => {
          const current = await tx.get('deliveries', job.notificationId);
          if (
            current.status !== 'PENDING' &&
            !(current.status === 'PROCESSING' && Date.now() - Date.parse(current.claimedAt) > 30000)
          )
            return null;
          const row = {
            ...current,
            status: 'PROCESSING',
            claimedAt: C.now(),
            attempts: current.attempts + 1,
          };
          await tx.put('deliveries', row.notificationId, row);
          return row;
        });
        if (!claimed) continue;
        try {
          await deliver(claimed);
        } catch (error) {
          await repository.tx(async (tx) => {
            const current = await tx.get('deliveries', claimed.notificationId);
            if (current.status !== 'PROCESSING') return;
            const failed = error.permanent || current.attempts >= 6;
            const notification = await tx.get('notifications', current.notificationId);
            if (failed && notification)
              await tx.put('notifications', current.notificationId, {
                ...notification,
                status: 'FAILED',
              });
            await tx.put('deliveries', current.notificationId, {
              ...current,
              status: failed ? 'FAILED' : 'PENDING',
              nextAt: null,
              errorCode: 'DELIVERY_ERROR',
            });
          });
        }
      }
    },
  };
};
