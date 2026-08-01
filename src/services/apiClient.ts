import axios from 'axios';

/**
 * Central Axios instance. Once a real backend exists, set VITE_API_BASE_URL
 * in `.env` and every service in this folder will start hitting it instead
 * of the in-memory mocks — no call-site changes required.
 */
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('tether_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Simulates network latency so the mocked UI feels like a real backend. */
export function mockDelay<T>(value: T, ms = 600): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
