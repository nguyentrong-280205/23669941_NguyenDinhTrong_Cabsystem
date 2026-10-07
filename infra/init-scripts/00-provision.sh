#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
  --set identity_password="$IDENTITY_DB_PASSWORD" --set booking_password="$BOOKING_DB_PASSWORD" --set payment_password="$PAYMENT_DB_PASSWORD" <<'SQL'
CREATE ROLE identity_user LOGIN PASSWORD :'identity_password';
CREATE ROLE booking_user LOGIN PASSWORD :'booking_password';
CREATE ROLE payment_user LOGIN PASSWORD :'payment_password';
CREATE DATABASE identity_db OWNER identity_user;
CREATE DATABASE booking_db OWNER booking_user;
CREATE DATABASE payment_db OWNER payment_user;
REVOKE CONNECT ON DATABASE identity_db, booking_db, payment_db FROM PUBLIC;
GRANT CONNECT ON DATABASE identity_db TO identity_user;
GRANT CONNECT ON DATABASE booking_db TO booking_user;
GRANT CONNECT ON DATABASE payment_db TO payment_user;
SQL
