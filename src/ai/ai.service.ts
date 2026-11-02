import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { APP_ENV } from '../config/app-config.module';
import type { AppEnv } from '../config/env.schema';
import { IngressRateLimitService } from '../common/security/ingress-rate-limit.service';

export const AI_REPLY_RATE_WINDOW_SECONDS = 3600;
export const AI_REPLY_RATE_MAX = 30;
export const AI_TIMEOUT_MS = 15_000;
const MAX_SUGGESTION_LENGTH = 600;

export type ReplySuggestionInput = {
  content: string;
  rating: number;
  author?: string;
  storeName?: string;
};

const stripMarkup = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildPrompt = (input: ReplySuggestionInput): string =>
  [
    'Bạn là nhân viên chăm sóc khách hàng của một cửa hàng trực tuyến tại Việt Nam.',
    'Viết một câu trả lời ngắn cho đánh giá sản phẩm dưới đây.',
    'Yêu cầu: tiếng Việt có dấu, lịch sự, cảm ơn khách, 1-3 câu, tối đa 300 ký tự,',
    'không bịa thông tin khuyến mãi, không chèn link, không chèn HTML, không hỏi thông tin cá nhân.',
    input.rating <= 2
      ? 'Khách chưa hài lòng: xin lỗi, đề nghị liên hệ để hỗ trợ, không hứa hẹn cụ thể.'
      : 'Khách hài lòng: cảm ơn chân thành và mời khách quay lại.',
    `Cửa hàng: ${input.storeName || 'cửa hàng'}.`,
    `Số sao: ${input.rating}/5.`,
    `Tên khách: ${input.author || 'Khách'}.`,
    `Nội dung đánh giá: ${input.content}`,
    'Chỉ trả về nội dung câu trả lời, không kèm giải thích.',
  ].join('\n');

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly rateLimit: IngressRateLimitService,
  ) {}

  get configured(): boolean {
    return Boolean(this.env.GEMINI_API_KEY);
  }

  get model(): string {
    return this.env.AI_MODEL;
  }

  async suggestReply(storeDomain: string, input: ReplySuggestionInput): Promise<{ suggestion: string; model: string }> {
    if (!this.configured) {
      throw new ServiceUnavailableException({
        code: 'ai_not_configured',
        message: 'AI chưa được cấu hình cho ứng dụng này (thiếu GEMINI_API_KEY)',
      });
    }
    await this.rateLimit.assertAllowed(
      'ai:reply-suggestion',
      storeDomain,
      AI_REPLY_RATE_WINDOW_SECONDS,
      AI_REPLY_RATE_MAX,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: buildPrompt(input) }] }],
            generationConfig: { temperature: 0.6, maxOutputTokens: 320 },
          }),
        },
      );
      if (!response.ok) {
        this.logger.warn(`AI provider answered ${response.status} for ${storeDomain}`);
        throw new ServiceUnavailableException({ code: 'ai_unavailable', message: 'Dịch vụ AI tạm thời không khả dụng' });
      }
      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      };
      const text = (payload.candidates ?? [])
        .flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join(' ');
      const suggestion = stripMarkup(text).slice(0, MAX_SUGGESTION_LENGTH);
      if (!suggestion) {
        throw new ServiceUnavailableException({ code: 'ai_empty', message: 'AI không trả về nội dung' });
      }
      return { suggestion, model: this.model };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(`AI reply suggestion failed for ${storeDomain}: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ServiceUnavailableException({ code: 'ai_unavailable', message: 'Dịch vụ AI tạm thời không khả dụng' });
    } finally {
      clearTimeout(timer);
    }
  }
}
