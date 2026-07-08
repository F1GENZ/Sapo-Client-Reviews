import { apiClient } from './api-client';

export type QnaItem = {
  questionId: string; productId: string; productTitle?: string; question: string;
  author: string; status: string; answer?: string; createdAt: number;
};

export type QnaListResponse = { items: QnaItem[]; total: number; page: number; pageSize: number };

export const fetchQuestions = (params: { page?: number; limit?: number; status?: string; sort?: string }) =>
  apiClient.get<QnaListResponse>('/admin/qna', { params }).then(r => r.data);

export const answerQuestion = (productId: string, questionId: string, answer: string) =>
  apiClient.patch(`/admin/qna/${productId}/${questionId}/answer`, { answer }).then(r => r.data);

export const updateQuestionStatus = (productId: string, questionId: string, status: string) =>
  apiClient.patch(`/admin/qna/${productId}/${questionId}/status`, { status }).then(r => r.data);
