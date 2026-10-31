import { prisma } from '../config/prisma.js';

const DEALER_CODE_QUERY_CHUNK_SIZE = 500;

export async function addOriginatingDealerCodes(visits, database = prisma) {
  const ccmIds = [...new Set(visits.map(({ ccmId }) => ccmId).filter(Boolean))];
  if (!ccmIds.length) return visits.map((visit) => ({ ...visit, dealerCode: null }));

  const ccmUsers = [];
  for (let offset = 0; offset < ccmIds.length; offset += DEALER_CODE_QUERY_CHUNK_SIZE) {
    const chunk = ccmIds.slice(offset, offset + DEALER_CODE_QUERY_CHUNK_SIZE);
    ccmUsers.push(...await database.user.findMany({
      where: { role: 'CCM', ccmId: { in: chunk } },
      select: { ccmId: true, dealerCode: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
  }
  const dealerCodeByCcmId = new Map();
  for (const { ccmId, dealerCode } of ccmUsers) {
    if (ccmId && dealerCode && !dealerCodeByCcmId.has(ccmId)) {
      dealerCodeByCcmId.set(ccmId, dealerCode);
    }
  }

  return visits.map((visit) => ({
    ...visit,
    dealerCode: dealerCodeByCcmId.get(visit.ccmId) || null,
  }));
}
