#!/bin/bash
set -euo pipefail
for cab_topic in cab.booking.events cab.trip.events cab.payment.events cab.driver.events cab.identity.otp; do
  cab_retention=604800000
  if [ "$cab_topic" = cab.identity.otp ]; then cab_retention=3600000; fi
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --create --if-not-exists --topic "$cab_topic" --partitions 3 --replication-factor 1 --config retention.ms="$cab_retention" --config min.insync.replicas=1
done
for cab_source_group in \
  cab.booking.events:booking.matching cab.booking.events:notification.events \
  cab.trip.events:booking.trip-status cab.trip.events:driver.trip-status cab.trip.events:notification.events \
  cab.payment.events:trip.payment-status cab.payment.events:notification.events \
  cab.driver.events:notification.events cab.identity.otp:notification.otp; do
  cab_topic="${cab_source_group%:*}.${cab_source_group#*:}.dlt"
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --create --if-not-exists --topic "$cab_topic" --partitions 3 --replication-factor 1 --config retention.ms=1209600000
done
