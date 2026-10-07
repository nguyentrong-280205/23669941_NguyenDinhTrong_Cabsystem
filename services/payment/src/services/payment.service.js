'use strict';
const C = require('../../../../shared/lib/core');
const { emit } = require('../../../../shared/lib/events');
const callbackSignature = (raw) => C.hmac(raw, 'PAYMENT_PROVIDER_SECRET');
module.exports = (repository) => {
  async function get(paymentId, tx = repository) {
    const row = await tx.get('payments', paymentId);
    C.demand(row, 404, 'NOT_FOUND', 'Payment not found');
    return row;
  }
  async function provider(payment) {
    C.demand(
      process.env.PAYMENT_PROVIDER_URL,
      500,
      'CONFIGURATION_ERROR',
      'Payment provider not configured',
    );
    const body = {
      paymentId: payment.paymentId,
      tripId: payment.tripId,
      amount: payment.amount,
      currency: payment.currency,
    };
    let response;
    try {
      response = await fetch(`${process.env.PAYMENT_PROVIDER_URL}/api/v1/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${C.secret('PAYMENT_PROVIDER_SECRET')}`,
          'idempotency-key': payment.paymentId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
    } catch (_) {
      C.fail(
        503,
        'PROVIDER_UNAVAILABLE',
        'Payment provider unavailable; request is scheduled for reconciliation',
      );
    }
    C.demand(
      response.ok,
      503,
      'PROVIDER_UNAVAILABLE',
      'Payment provider did not acknowledge request',
    );
    const result = await response.json();
    C.demand(
      result.providerTransactionId,
      503,
      'PROVIDER_UNAVAILABLE',
      'Invalid provider response',
    );
    await repository.tx(async (tx) => {
      const current = await get(payment.paymentId, tx);
      const attempt = await tx.get('attempts', payment.paymentId);
      await tx.put('attempts', payment.paymentId, {
        ...attempt,
        submitted: true,
        providerTransactionId: result.providerTransactionId,
        acknowledgedAt: C.now(),
      });
      if (!current.providerTransactionId)
        await tx.put('payments', current.paymentId, {
          ...current,
          providerTransactionId: result.providerTransactionId,
        });
    });
  }
  const actions = {
    createPayment: async (input) => {
      const key = input.headers['idempotency-key'];
      C.demand(
        typeof key === 'string' && key.length <= 100 && key.length > 0,
        400,
        'VALIDATION_ERROR',
        'Idempotency-Key required',
      );
      const recordId = `${input.user.userId}:${key}`,
        requestHash = C.hash(input.body);
      const replay = await repository.get('idempotency', recordId);
      if (replay) {
        C.demand(
          replay.requestHash === requestHash,
          409,
          'IDEMPOTENCY_CONFLICT',
          'Same key with different request',
        );
        return { httpStatus: 202, body: replay.response };
      }
      const fare = await C.ipc(
        'trip',
        `/api/v1/internal-trips/${encodeURIComponent(input.body.tripId)}/payment-contexts`,
        { user: input.user },
      );
      C.demand(
        fare.customerId === input.user.customerId && fare.userId === input.user.userId,
        403,
        'FORBIDDEN',
        'Payment is not owned by this Customer',
      );
      C.demand(
        fare.status === 'COMPLETED' &&
          Number.isSafeInteger(fare.fare?.totalAmount) &&
          fare.fare.totalAmount >= 0 &&
          fare.fare.currency === 'VND' &&
          fare.fare.fareId &&
          fare.paymentStatus !== 'PAID',
        409,
        'FARE_NOT_READY',
        'Completed Trip with unpaid Fare required',
      );
      const response = await repository.tx(async (tx) => {
        const old = await tx.get('idempotency', recordId);
        if (old) {
          C.demand(
            old.requestHash === requestHash,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Same key with different request',
          );
          return old.response;
        }
        const prior = await tx.list('payments', { tripId: fare.tripId });
        C.demand(
          !prior.some((p) => ['PROCESSING', 'PENDING', 'COMPLETED'].includes(p.status)),
          409,
          'TRIP_PAYMENT_EXISTS',
          'Trip already has an active or completed payment',
        );
        const paymentId = C.id(),
          payment = {
            paymentId,
            tripId: fare.tripId,
            customerId: fare.customerId,
            userId: input.user.userId,
            method: input.body.method,
            amount: fare.fare.totalAmount,
            currency: fare.fare.currency,
            fareId: fare.fare.fareId,
            fareVersion: fare.fare.pricingVersion,
            status: 'PROCESSING',
            version: 1,
            createdAt: C.now(),
            updatedAt: C.now(),
          };
        const result = { paymentId, status: 'PROCESSING' };
        await tx.create('payments', paymentId, payment);
        await tx.create('idempotency', recordId, {
          userId: input.user.userId,
          key,
          requestHash,
          response: result,
          paymentId,
        });
        await tx.create('attempts', paymentId, { paymentId, submitted: false, createdAt: C.now() });
        await emit(tx, 'payment.processing', payment.tripId, 1, {
          paymentId,
          tripId: payment.tripId,
          customerId: payment.customerId,
          amount: payment.amount,
          currency: payment.currency,
        });
        await C.audit(tx, 'payment.created', paymentId);
        return result;
      });
      // Persisted job invokes/reconciles the provider with paymentId as its stable key.
      return { httpStatus: 202, body: response };
    },
    processCallback: async (input) => {
      C.demand(
        input.rawBody &&
          C.equal(input.headers['x-provider-signature'], callbackSignature(input.rawBody)),
        401,
        'INVALID_SIGNATURE',
        'Invalid provider signature',
      );
      return repository.tx(async (tx) => {
        const payment = await get(input.body.paymentId, tx);
        C.demand(
          input.body.amount === payment.amount && input.body.currency === payment.currency,
          400,
          'INVALID_PAYMENT_AMOUNT',
          'Callback amount or currency mismatch',
        );
        C.demand(
          !payment.providerTransactionId ||
            payment.providerTransactionId === input.body.providerTransactionId,
          400,
          'INVALID_PROVIDER_REFERENCE',
          'Provider reference mismatch',
        );
        const reference = (
          await tx.list('payments', { providerTransactionId: input.body.providerTransactionId })
        )[0];
        C.demand(
          !reference || reference.paymentId === payment.paymentId,
          400,
          'INVALID_PROVIDER_REFERENCE',
          'Provider reference belongs to another payment',
        );
        const receiptId = C.hash(input.body),
          old = await tx.get('callbacks', receiptId);
        if (old) return { ack: true };
        const terminal = ['COMPLETED', 'FAILED'].includes(payment.status);
        C.demand(
          !terminal || payment.status === input.body.status,
          409,
          'PAYMENT_FINALIZED',
          'Final payment state cannot regress',
        );
        if (!terminal && payment.status !== input.body.status) {
          const row = {
            ...payment,
            status: input.body.status,
            providerTransactionId: input.body.providerTransactionId,
            version: payment.version + 1,
            updatedAt: C.now(),
          };
          await tx.put('payments', payment.paymentId, row);
          await emit(tx, `payment.${row.status.toLowerCase()}`, payment.tripId, row.version, {
            paymentId: payment.paymentId,
            tripId: payment.tripId,
            customerId: payment.customerId,
            amount: payment.amount,
            currency: payment.currency,
            ...(row.status === 'FAILED' ? { failureCode: 'PROVIDER_FAILED' } : {}),
          });
          await C.audit(tx, 'payment.callback', payment.paymentId, 'provider');
        }
        await tx.create('callbacks', receiptId, {
          paymentId: payment.paymentId,
          providerTransactionId: input.body.providerTransactionId,
          status: input.body.status,
          receivedAt: C.now(),
        });
        return { ack: true };
      });
    },
    getPayment: async (input) => {
      const row = await get(input.params.id);
      C.owner(input.user, 'customer', row.customerId);
      const { userId, ...result } = row;
      return result;
    },
  };
  return {
    actions,
    async tick() {
      for (const attempt of await repository.list('attempts', { submitted: false })) {
        try {
          await provider(await get(attempt.paymentId));
        } catch (_) {
          /* persisted retry, no second logical charge */
        }
      }
    },
  };
};
module.exports.callbackSignature = callbackSignature;
