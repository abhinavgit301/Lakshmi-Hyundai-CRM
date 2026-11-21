const ID_BATCH_SIZE = 500;

export async function* iterateByIdBatches(ids, readBatch) {
  const uniqueIds = [...new Set(ids)];
  for (let offset = 0; offset < uniqueIds.length; offset += ID_BATCH_SIZE) {
    const batchIds = uniqueIds.slice(offset, offset + ID_BATCH_SIZE);
    yield { ids: batchIds, rows: await readBatch(batchIds) };
  }
}

export async function readByIdBatches(ids, readBatch) {
  const rows = [];
  for await (const { rows: batch } of iterateByIdBatches(ids, readBatch)) {
    for (const row of batch) rows.push(row);
  }
  return rows;
}
