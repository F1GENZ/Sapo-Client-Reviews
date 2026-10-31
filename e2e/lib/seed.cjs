async function seedCatalogProducts(prisma, storeDomain, productIds, { deleted = false } = {}) {
  const shop = await prisma.shop.findUnique({ where: { storeDomain } });
  if (!shop) throw new Error(`cannot seed catalog: no shop row for ${storeDomain}`);
  const now = BigInt(Date.now());
  for (const productId of productIds) {
    const data = {
      title: `E2E product ${productId}`,
      handle: `e2e-product-${productId}`,
      image: "https://cdn.example.com/e2e.jpg",
      status: "active",
      published: true,
      deletedAt: deleted ? now : null,
      updatedAt: now,
      source: "e2e",
    };
    await prisma.catalogProduct.upsert({
      where: { shopId_productId: { shopId: shop.id, productId } },
      create: { shopId: shop.id, productId, ...data },
      update: data,
    });
  }
}

module.exports = { seedCatalogProducts };
