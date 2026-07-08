import { apiClient } from './api-client';

export type ReviewItem = {
  reviewId: string; productId: string; productTitle?: string; rating: number;
  content: string; author: string; status: string; verified: boolean; pinned: boolean;
  reply?: string; createdAt: number;
};

export type ReviewListResponse = { items: ReviewItem[]; total: number; page: number; pageSize: number };

export const fetchReviews = (params: { page?: number; limit?: number; status?: string; sort?: string; productId?: string }) =>
  apiClient.get<ReviewListResponse>('/admin/reviews', { params }).then(r => r.data);

export const updateReviewStatus = (productId: string, reviewId: string, status: string) =>
  apiClient.patch(`/admin/reviews/${productId}/${reviewId}/status`, { status }).then(r => r.data);

export const replyToReview = (productId: string, reviewId: string, reply: string) =>
  apiClient.patch(`/admin/reviews/${productId}/${reviewId}/reply`, { reply }).then(r => r.data);

export const pinReview = (productId: string, reviewId: string, pinned: boolean) =>
  apiClient.patch(`/admin/reviews/${productId}/${reviewId}/pin`, { pinned }).then(r => r.data);

export const getReviewStats = (productId: string) =>
  apiClient.get(`/admin/reviews/${productId}/stats`).then(r => r.data);
