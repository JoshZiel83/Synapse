#!/usr/bin/env bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'EOSQL'
SELECT 'CREATE DATABASE spicedb'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_database
  WHERE datname = 'spicedb'
)\gexec
EOSQL
