import { prisma } from '../config/prisma.js';

export async function addOriginatingDealerCodes(visits, database = prisma) {
  const ccmIds = [...new Set(visits.map(({ ccmId }) => ccmId).filter(Boolean))];
  if (!ccmIds.length) return visits.map((visit) => ({ ...visit, dealerCode: null }));

  const ccmUsers = await database.user.findMany({
    where: { role: 'CCM', ccmId: { in: ccmIds } },
    select: { ccmId: true, dealerCode: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
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
