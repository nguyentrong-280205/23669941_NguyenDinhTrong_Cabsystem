'use strict';
const path = require('node:path');
const { id, now, context, demand } = require('./core');
const topicFor = (type) =>
  `cab.${type === 'otp.requested' ? 'identity.otp' : ['driver.assigned', 'driver.arrived'].includes(type) || type.startsWith('trip.') ? 'trip.events' : type.startsWith('offer.') ? 'booking.events' : type === 'driver.application.reviewed' ? 'driver.events' : `${type.split('.')[0]}.events`}`;
const schemaNames = {
  'cab.booking.events': 'booking',
  'cab.trip.events': 'trip',
  'cab.payment.events': 'payment',
  'cab.driver.events': 'driver',
  'cab.identity.otp': 'identity',
};
let validators;
function validateEvent(topic, event) {
  if (!validators) {
    const Ajv = require('ajv/dist/2020'),
      addFormats = require('ajv-formats');
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    ajv.addSchema(
      require(path.resolve(__dirname, '../../docs/api_document/kafka/event-envelope.schema.json')),
      'event-envelope.schema.json',
    );
    validators = Object.fromEntries(
      Object.entries(schemaNames).map(([t, n]) => [
        t,
        ajv.compile(
          require(path.resolve(__dirname, `../../docs/api_document/kafka/${n}.events.schema.json`)),
        ),
      ]),
    );
  }
  demand(validators[topic]?.(event), 400, 'INVALID_EVENT', 'Invalid event contract');
}
async function emit(tx, type, aggregateId, aggregateVersion, payload) {
  const event = {
    eventId: id(),
    eventType: type,
    version: 1,
    aggregateId,
    aggregateVersion,
    occurredAt: now(),
    correlationId: context.getStore()?.correlationId || id(),
    payload,
  };
  const topic = topicFor(type);
  validateEvent(topic, event);
  await tx.create('outbox', event.eventId, {
    eventId: event.eventId,
    topic,
    key: aggregateId,
    event,
    sent: false,
    createdAt: event.occurredAt,
  });
}
async function consume(store, group, event, handler) {
  return store.tx(async (tx) => {
    const key = `${group}:${event.eventId}`;
    if (await tx.get('inbox', key)) return;
    await handler(tx, event);
    await tx.create('inbox', key, { key, eventId: event.eventId, group, createdAt: now() });
  });
}
async function startEvents(store, service, subscriptions = []) {
  const { Kafka, logLevel } = require('kafkajs');
  const kafka = new Kafka({
    clientId: `cab-${service}`,
    brokers: process.env.KAFKA_BOOTSTRAP_SERVERS.split(','),
    logLevel: logLevel.ERROR,
    retry: { retries: 5 },
  });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  let stopped = false,
    publishing = false;
  async function flush() {
    if (stopped || publishing) return;
    publishing = true;
    try {
      const pending = (await store.list('outbox', { sent: false })).sort((a, b) =>
        a.event.aggregateId === b.event.aggregateId
          ? a.event.aggregateVersion - b.event.aggregateVersion
          : a.createdAt.localeCompare(b.createdAt),
      );
      for (const row of pending) {
        await producer.send({
          topic: row.topic,
          acks: -1,
          messages: [{ key: row.key, value: JSON.stringify(row.event) }],
        });
        await store.tx(async (tx) => {
          const current = await tx.get('outbox', row.eventId);
          if (current)
            await tx.put('outbox', row.eventId, { ...current, sent: true, sentAt: now() });
        });
      }
    } catch (_) {
      console.error(JSON.stringify({ service, code: 'OUTBOX_RETRY' }));
    } finally {
      publishing = false;
    }
  }
  const timer = setInterval(flush, 500);
  timer.unref();
  const consumers = [];
  for (const { group, topics, handler, prepare } of subscriptions) {
    const consumer = kafka.consumer({ groupId: group });
    await consumer.connect();
    for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        for (const message of batch.messages) {
          if (!isRunning() || isStale()) return;
          let parsed,
            error,
            delivered = false;
          for (let attempt = 0; attempt <= 5; attempt++) {
            try {
              parsed = JSON.parse(message.value.toString());
              validateEvent(batch.topic, parsed);
              demand(
                message.key?.toString() === parsed.aggregateId,
                400,
                'INVALID_EVENT_KEY',
                'Partition key mismatch',
              );
              await context.run({ service, correlationId: parsed.correlationId }, async () => {
                const prepared = prepare ? await prepare(parsed) : parsed;
                await consume(store, group, prepared, handler);
              });
              delivered = true;
              break;
            } catch (e) {
              error = e;
              if (attempt < 5) {
                for (let i = 0; i < 2 ** attempt; i++) {
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  await heartbeat();
                }
              }
            }
          }
          if (!delivered) {
            const dlt = `${batch.topic}.${group}.dlt`;
            // DLT contains original bytes (OTP is encrypted), plus masked diagnostics. Publish before offset commit.
            await producer.send({
              topic: dlt,
              acks: -1,
              messages: [
                {
                  key: message.key,
                  value: JSON.stringify({
                    eventId: parsed?.eventId,
                    original: message.value.toString(),
                    topic: batch.topic,
                    partition: batch.partition,
                    offset: message.offset,
                    attempts: 6,
                    errorCode: error?.code || 'PROCESSING_ERROR',
                    failedAt: now(),
                  }),
                },
              ],
            });
          }
          resolveOffset(message.offset);
          await consumer.commitOffsets([
            {
              topic: batch.topic,
              partition: batch.partition,
              offset: (BigInt(message.offset) + 1n).toString(),
            },
          ]);
          await heartbeat();
        }
      },
    });
    consumers.push(consumer);
  }
  return {
    flush,
    async close() {
      stopped = true;
      clearInterval(timer);
      for (const c of consumers) await c.disconnect();
      while (publishing) await new Promise((r) => setTimeout(r, 20));
      await producer.disconnect();
    },
    async ping() {
      const admin = kafka.admin();
      try {
        await admin.connect();
        await admin.listTopics();
      } finally {
        await admin.disconnect();
      }
    },
  };
}
module.exports = { emit, consume, validateEvent, startEvents, topicFor };
