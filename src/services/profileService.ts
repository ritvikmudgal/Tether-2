import { apiClient } from './apiClient';
import { toFrontendUser } from './authService';
import type { User } from '../types';

export const profileService = {
  async get(userId: string): Promise<User> {
    try {
      const { data } = await apiClient.get(`/users/${userId}/profile`);
      return toFrontendUser(data.user);
    } catch (err) {
      console.warn('[ProfileService] Backend get profile offline, using cached local session:', err);
      const cached = localStorage.getItem('tether_user');
      if (cached) {
        return JSON.parse(cached) as User;
      }
      return {
        id: userId,
        name: userId.startsWith('guest') ? 'Guest User' : 'Tether User',
        email: userId.startsWith('guest') ? 'guest@tether.app' : 'user@tether.app',
      };
    }
  },
  async update(current: User, patch: Partial<User>): Promise<User> {
    try {
      const { data } = await apiClient.put(`/users/${current.id}/profile`, patch);
      return toFrontendUser(data.user);
    } catch (err) {
      console.warn('[ProfileService] Backend update profile offline, updating locally:', err);
      return { ...current, ...patch };
    }
  },
  async uploadAvatar(file: File): Promise<{ url: string }> {
    const url = URL.createObjectURL(file);
    return { url };
  },
};
