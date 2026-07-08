import axios from 'axios';

type ErrorPayload = {
  error?: unknown;
  message?: unknown;
};

const stringFromPayload = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as ErrorPayload;
  if (typeof data.message === 'string') return data.message;
  if (Array.isArray(data.message) && typeof data.message[0] === 'string') return data.message[0];
  if (typeof data.error === 'string') return data.error;
  return null;
};

export const getErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    return stringFromPayload(error.response?.data) || error.message || 'Request failed';
  }
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
};
