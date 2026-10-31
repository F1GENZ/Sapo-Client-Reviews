import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { detectSpam } from '../src/review/review.service';
import { DEFAULT_SPAM_CONFIG } from '../src/review/interfaces/spam-config.interface';
import { UpdateSpamConfigDto } from '../src/review/dto/update-spam-config.dto';

const cfg = { ...DEFAULT_SPAM_CONFIG, blockedWords: ['casino'] };

test('a clean review waits in pending unless the widget autoApprove switch is on', () => {
  assert.equal(detectSpam('Sản phẩm rất tốt', 'An', cfg, []), 'pending');
  assert.equal(detectSpam('Sản phẩm rất tốt', 'An', cfg, [], true), 'approved');
});

test('spam rules win over autoApprove', () => {
  assert.equal(detectSpam('Best CASINO bonus', 'An', cfg, [], true), 'spam');
  assert.equal(detectSpam('x'.repeat(21), 'An', { ...cfg, maxContentLength: 20 }, [], true), 'spam');
  assert.equal(
    detectSpam('Rất tốt', 'An', cfg, [{ author: 'an', content: 'rất tốt' }], true),
    'spam',
  );
});

test('spam config DTO keeps the keys the server evaluates and strips the rest', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const out = (await pipe.transform(
    { blockedWords: ['a'], maxContentLength: 100, maxUrls: 2, autoApprove: true },
    { type: 'body', metatype: UpdateSpamConfigDto },
  )) as Record<string, unknown>;
  const defined = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  assert.deepEqual(defined, { blockedWords: ['a'], maxContentLength: 100 });
});
