import { Controller, Get, Param, Query, Req, UseGuards, NotFoundException } from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { PrismaService } from '../database/prisma.service';
import { CatalogProductStoreService } from './catalog-product-store.service';

interface AdminProduct {
  id: string;
  productId: string;
  title: string;
  handle: string;
  image?: { src?: string };
  images: { src?: string }[];
  featured_image?: string;
  productImage?: string;
  vendor?: string;
  productType?: string;
  tags?: string;
  status?: string;
  updatedAt: number;
}

function toAdminProduct(p: {
  id: string;
  productId: string;
  title: string;
  handle: string;
  image?: { src?: string };
  productImage?: string;
  vendor?: string;
  productType?: string;
  tags?: string;
  status?: string;
  updatedAt: number;
}): AdminProduct {
  return {
    id: p.productId,
    productId: p.productId,
    title: p.title,
    handle: p.handle,
    image: p.image,
    images: p.image ? [p.image] : [],
    featured_image: p.productImage,
    productImage: p.productImage,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    status: p.status,
    updatedAt: p.updatedAt,
  };
}

@Controller('/api/admin/products')
@UseGuards(ShopAuthGuard)
export class ProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productStore: CatalogProductStoreService,
  ) {}

  private async resolveShopId(storeDomain: string): Promise<string> {
    const install = await this.prisma.appInstall.findUnique({
      where: { storeDomain },
      select: { shopId: true },
    });
    if (!install?.shopId) throw new NotFoundException('Store install not found');
    return install.shopId;
  }

  @Get()
  async list(
    @Req() req: { storeDomain?: string },
    @Query('title') title?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    const shopId = await this.resolveShopId(req.storeDomain || '');
    const { products, total } = await this.productStore.listProducts(shopId, {
      title,
      limit: limit ? Number(limit) : undefined,
      page: page ? Number(page) : undefined,
    });
    return { data: { products: products.map(toAdminProduct), total } };
  }

  @Get(':productId')
  async get(
    @Req() req: { storeDomain?: string },
    @Param('productId') productId: string,
  ) {
    const shopId = await this.resolveShopId(req.storeDomain || '');
    const product = await this.productStore.getProduct(shopId, productId);
    if (!product) throw new NotFoundException('Product not found');
    return { data: { product: toAdminProduct(product) } };
  }
}
