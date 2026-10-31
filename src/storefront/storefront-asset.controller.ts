import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join } from 'path';
import { readFileSync, existsSync, statSync } from 'fs';
import { STOREFRONT_ASSET_CACHE_CONTROL } from './storefront-asset-cache';

@Controller('storefront')
export class StorefrontAssetController {
  private runtimeJs: string | null = null;
  private runtimeCss: string | null = null;
  private jsLastModified: Date | null = null;
  private cssLastModified: Date | null = null;
  private jsFilePath: string | null = null;
  private cssFilePath: string | null = null;
  private jsFileMtime: number | null = null;
  private cssFileMtime: number | null = null;

  private getRuntimeJs(): string {
    if (this.runtimeJs && this.jsFilePath) {
      try {
        const stat = statSync(this.jsFilePath);
        if (stat.mtimeMs !== this.jsFileMtime) {
          this.runtimeJs = readFileSync(this.jsFilePath, 'utf-8');
          this.jsFileMtime = stat.mtimeMs;
          this.jsLastModified = stat.mtime;
        }
        return this.runtimeJs;
      } catch { this.runtimeJs = null; this.jsFilePath = null; }
    }
    for (const p of [
      join(__dirname, '..', '..', 'storefront', 'snippets', 'f1genz-storefront.js'),
      join(process.cwd(), 'storefront', 'snippets', 'f1genz-storefront.js'),
    ]) {
      if (existsSync(p)) {
        const stat = statSync(p);
        this.runtimeJs = readFileSync(p, 'utf-8');
        this.jsFilePath = p;
        this.jsFileMtime = stat.mtimeMs;
        this.jsLastModified = stat.mtime;
        return this.runtimeJs;
      }
    }
    throw new Error('Storefront runtime JS file not found');
  }

  private getRuntimeCss(): string {
    if (this.runtimeCss && this.cssFilePath) {
      try {
        const stat = statSync(this.cssFilePath);
        if (stat.mtimeMs !== this.cssFileMtime) {
          this.runtimeCss = readFileSync(this.cssFilePath, 'utf-8');
          this.cssFileMtime = stat.mtimeMs;
          this.cssLastModified = stat.mtime;
        }
        return this.runtimeCss;
      } catch { this.runtimeCss = null; this.cssFilePath = null; }
    }
    for (const p of [
      join(__dirname, '..', '..', 'storefront', 'snippets', 'f1genz-storefront.css'),
      join(process.cwd(), 'storefront', 'snippets', 'f1genz-storefront.css'),
    ]) {
      if (existsSync(p)) {
        const stat = statSync(p);
        this.runtimeCss = readFileSync(p, 'utf-8');
        this.cssFilePath = p;
        this.cssFileMtime = stat.mtimeMs;
        this.cssLastModified = stat.mtime;
        return this.runtimeCss;
      }
    }
    throw new Error('Storefront runtime CSS file not found');
  }

  @Get('f1genz-storefront.js')
  serveJs(@Res() res: Response) {
    try {
      const js = this.getRuntimeJs();
      res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': STOREFRONT_ASSET_CACHE_CONTROL, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
      if (this.jsLastModified) res.set('Last-Modified', this.jsLastModified.toUTCString());
      res.send(js);
    } catch { res.status(404).send('// Widget not found'); }
  }

  @Get('f1genz-storefront.css')
  serveCss(@Res() res: Response) {
    try {
      const css = this.getRuntimeCss();
      res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STOREFRONT_ASSET_CACHE_CONTROL, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
      if (this.cssLastModified) res.set('Last-Modified', this.cssLastModified.toUTCString());
      res.send(css);
    } catch { res.status(404).send('/* Storefront CSS not found */'); }
  }
}
