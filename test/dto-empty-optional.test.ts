import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateReviewDto } from '../src/review/dto/update-review.dto';
import { CreateReviewDto } from '../src/review/dto/create-review.dto';
import { CreateQuestionDto } from '../src/qna/dto/create-question.dto';

const errorsFor = async (cls: new () => object, plain: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, plain))).flatMap((e) => Object.keys(e.constraints ?? {}).map(() => e.property));

test('editing a review that has no email accepts the empty string the SPA sends', async () => {
  assert.deepEqual(await errorsFor(UpdateReviewDto, { author: 'a', email: '', phone: '' }), []);
});

test('a malformed email is still rejected on every DTO that takes one', async () => {
  assert.deepEqual(await errorsFor(UpdateReviewDto, { email: 'not-an-email' }), ['email', 'email']);
  assert.ok((await errorsFor(CreateReviewDto, { rating: 5, author: 'a', email: 'x@' })).includes('email'));
  assert.ok((await errorsFor(CreateQuestionDto, { question: 'q', author: 'a', email: 'nope' })).includes('email'));
});

test('create DTOs accept an empty or absent email', async () => {
  assert.deepEqual(await errorsFor(CreateReviewDto, { rating: 5, author: 'a', email: '' }), []);
  assert.deepEqual(await errorsFor(CreateQuestionDto, { question: 'q', author: 'a', email: '' }), []);
  assert.deepEqual(await errorsFor(CreateQuestionDto, { question: 'q', author: 'a' }), []);
});
