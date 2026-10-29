import { Client } from 'pg';

export async function acquireImportProcessingLock(batchId, createClient = (options) => new Client(options)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not configured.');
  const client = createClient({ connectionString });
  let connectionError;
  client.on?.('error', (error) => {
    connectionError ??= error;
    console.error('Import processing lock connection was lost.', error);
  });
  let transactionOpen = false;
  let lockHeld = false;
  let primaryError;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
      [`repair-order-import:${batchId}`],
    );
    if (!result.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }

    lockHeld = true;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        if (connectionError) throw connectionError;
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        primaryError = connectionError || error;
        if (transactionOpen && !connectionError && client._queryable !== false) {
          try {
            await client.query('ROLLBACK');
          } catch (cleanupError) {
            console.error('Failed to roll back the import processing lock transaction.', cleanupError);
          }
        }
        throw primaryError;
      } finally {
        try {
          await client.end();
        } catch (cleanupError) {
          if (primaryError) {
            console.error('Failed to close the import processing lock client after a release error.', cleanupError);
          } else {
            throw cleanupError;
          }
        }
      }
    };
  } catch (error) {
    primaryError = error;
    if (transactionOpen && !connectionError && client._queryable !== false) {
      try {
        await client.query('ROLLBACK');
      } catch (cleanupError) {
        console.error('Failed to roll back the import processing lock transaction.', cleanupError);
      }
    }
    throw error;
  } finally {
    if (!lockHeld) {
      try {
        await client.end();
      } catch (cleanupError) {
        if (primaryError) {
          console.error('Failed to close the import processing lock client after an acquisition error.', cleanupError);
        } else {
          throw cleanupError;
        }
      }
    }
  }
}

export async function assertImportBatchProcessing(transaction, batchId) {
  const rows = await transaction.$queryRaw`
    SELECT "status" FROM "import_batches" WHERE "id" = ${batchId} FOR UPDATE
  `;
  if (rows[0]?.status !== 'processing') {
    throw new Error('Import processing was stopped because the batch is no longer active.');
  }
}
