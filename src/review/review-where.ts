import type { Prisma } from '@prisma/client';

export const UNREPLIED_WHERE: Prisma.ReviewProductWhereInput = {
  OR: [{ reply: null }, { reply: '' }],
};
