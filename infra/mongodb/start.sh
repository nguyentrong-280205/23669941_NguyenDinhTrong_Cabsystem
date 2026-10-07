#!/bin/bash
set -euo pipefail
mkdir -p /data/configdb /data/db
if [ ! -f /data/configdb/cab-keyfile ]; then
  head -c 756 /dev/urandom | base64 > /data/configdb/cab-keyfile
fi
chmod 600 /data/configdb/cab-keyfile
chown -R mongodb:mongodb /data/db /data/configdb
gosu mongodb mongod --bind_ip_all --replSet rs0 --auth --keyFile /data/configdb/cab-keyfile &
cab_mongo_pid=$!
trap 'kill -TERM "$cab_mongo_pid"; wait "$cab_mongo_pid"' TERM INT
cab_ready=false
for cab_attempt in $(seq 1 90); do
  if mongosh --quiet --file /bootstrap/setup.js >/dev/null 2>&1; then cab_ready=true; break; fi
  sleep 1
done
if [ "$cab_ready" != true ]; then echo 'MongoDB bootstrap failed; credentials or replica set unavailable' >&2; kill -TERM "$cab_mongo_pid"; exit 1; fi
wait "$cab_mongo_pid"
