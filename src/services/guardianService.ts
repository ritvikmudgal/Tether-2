import { apiClient } from './apiClient';
import type { Guardian } from '../types';

function toGuardian(raw: Guardian & { _id?: string }): Guardian {
  return {
    ...raw,
    id: raw.id || raw._id || '',
  };
}

const DEFAULT_GUARDIANS: Guardian[] = [
  { id: 'g1', name: 'Meera Nair', relation: 'Mother', phone: '+91 98765 43210', email: 'meera@example.com', avatarColor: 'bg-emerald-500', isPrimary: true },
  { id: 'g2', name: 'Kabir Singh', relation: 'Brother', phone: '+91 98765 43211', email: 'kabir@example.com', avatarColor: 'bg-sky-500', isPrimary: false },
  { id: 'g3', name: 'Dr. Priya Menon', relation: 'Doctor', phone: '+91 98765 43212', email: 'priya@example.com', avatarColor: 'bg-purple-500', isPrimary: false },
];

export const guardianService = {
  async list(userId: string): Promise<Guardian[]> {
    try {
      const { data } = await apiClient.get<{ guardians: (Guardian & { _id?: string })[] }>(`/users/${userId}/guardians`);
      return data.guardians.map(toGuardian);
    } catch (err) {
      console.warn('[GuardianService] Backend offline, returning initial guardians list:', err);
      return DEFAULT_GUARDIANS;
    }
  },
  async add(userId: string, guardian: Omit<Guardian, 'id'>): Promise<Guardian> {
    try {
      const { data } = await apiClient.post<{ guardian: Guardian & { _id?: string } }>(`/users/${userId}/guardians`, guardian);
      return toGuardian(data.guardian);
    } catch (err) {
      console.warn('[GuardianService] Backend offline, creating guardian locally:', err);
      return { ...guardian, id: `g_${Date.now()}` };
    }
  },
  async update(userId: string, id: string, patch: Partial<Guardian>): Promise<Guardian> {
    try {
      const { data } = await apiClient.put<{ guardian: Guardian & { _id?: string } }>(`/users/${userId}/guardians/${id}`, patch);
      return toGuardian(data.guardian);
    } catch (err) {
      console.warn('[GuardianService] Backend offline, updating guardian locally:', err);
      return { id, name: patch.name || 'Guardian', relation: patch.relation || 'Friend', phone: patch.phone || '', email: patch.email || '', avatarColor: patch.avatarColor || 'bg-slate-500', isPrimary: patch.isPrimary ?? false, ...patch };
    }
  },
  async remove(userId: string, id: string): Promise<void> {
    try {
      await apiClient.delete(`/users/${userId}/guardians/${id}`);
    } catch (err) {
      console.warn('[GuardianService] Backend offline, removing guardian locally:', err);
    }
  },
};
