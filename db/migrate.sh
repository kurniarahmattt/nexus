#!/usr/bin/env bash
# ============================================================================
# db/migrate.sh — apply pending migrations against running Postgres container.
# ============================================================================
# Phase 0 note: *.sql files in db/migrations/ are auto-applied by the
# Postgres entrypoint while the volume is still empty. This script is for
# INCREMENTAL migrations after the volume has been populated (Phase 1+).
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/migrations"

# Load .env if present
if [ -f "${SCRIPT_DIR}/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/../.env"
  set +a
fi

PGUSER="${POSTGRES_USER:-nexus}"
PGDB="${POSTGRES_DB:-nexus}"
CONTAINER="${POSTGRES_CONTAINER:-nexus-postgres}"

echo "Running pending migrations against ${CONTAINER} (db=${PGDB}, user=${PGUSER})"

# Read which versions have already been applied
APPLIED=$(docker exec "${CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -At \
  -c "SELECT version FROM schema_migrations ORDER BY version;" 2>/dev/null || echo "")

for sqlfile in $(ls "${MIGRATIONS_DIR}"/*.sql | sort); do
  fname=$(basename "${sqlfile}" .sql)
  if echo "${APPLIED}" | grep -qx "${fname}"; then
    echo "  skip  ${fname} (already applied)"
    continue
  fi
  echo "  apply ${fname}"
  docker exec -i "${CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 < "${sqlfile}"
done

echo "Done."
