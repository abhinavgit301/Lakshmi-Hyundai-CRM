import { prisma } from '../config/prisma.js';

const DEALER_CODE_QUERY_CHUNK_SIZE = 500;

export async function getOriginatingDealerCodeMap(ccmIds, database = prisma) {
  const uniqueCcmIds = [...new Set(ccmIds.filter(Boolean))];
  if (!uniqueCcmIds.length) return new Map();

  const dealerCodeByCcmId = new Map();
  for (let offset = 0; offset < uniqueCcmIds.length; offset += DEALER_CODE_QUERY_CHUNK_SIZE) {
    const chunk = uniqueCcmIds.slice(offset, offset + DEALER_CODE_QUERY_CHUNK_SIZE);
    const ccmUsers = await database.user.findMany({
      where: { role: 'CCM', ccmId: { in: chunk } },
      select: { ccmId: true, dealerCode: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const { ccmId, dealerCode } of ccmUsers) {
      if (ccmId && dealerCode && !dealerCodeByCcmId.has(ccmId)) {
        dealerCodeByCcmId.set(ccmId, dealerCode);
      }
    }
  }

  return dealerCodeByCcmId;
}

export async function addOriginatingDealerCodes(visits, database = prisma) {
  const dealerCodeByCcmId = await getOriginatingDealerCodeMap(
    visits.map(({ ccmId }) => ccmId),
    database,
  );
  return visits.map((visit) => ({
    ...visit,
    dealerCode: dealerCodeByCcmId.get(visit.ccmId) || null,
  }));
}
