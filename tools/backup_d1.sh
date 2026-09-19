#!/bin/bash
# tools/backup_d1.sh — export the full whalesignal D1 database to a local
# SQL file. Run weekly (or before any risky deploy) and store the output
# somewhere safe (S3, Google Drive, etc). D1 has no automatic backups.
#
# Usage: CF_ID=<token> ./tools/backup_d1.sh

set -e
if [ -z "$CF_ID" ]; then echo "CF_ID not set"; exit 1;
fi
DATE=$(date -u +%Y%m%d_%H%M%S)
OUTFILE="whalesignal_backup_${DATE}.sql"
echo "Exporting whalesignal-db → ${OUTFILE}..."
npx wrangler d1 export whalesignal-db --remote --output "${OUTFILE}"
echo "Done. Store ${OUTFILE} somewhere safe (it contains your entire dataset)."