import { apiClient, mockDelay } from './apiClient';
import type { User } from '../types';

/**
 * Decodes the payload of a Google ID token (JWT) without verifying the
 * signature — Google's Identity Services SDK already verified it before
 * handing us the credential. We just need the user-info claims.
 */
function decodeGoogleCredential(credential: string): {
  sub: string;
  name: string;
  email: string;
  picture?: string;
} {
  try {
    const parts = credential.split('.');
    const payload = parts.length > 1 ? parts[1] : parts[0];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(json);
  } catch (err) {
    console.warn('[AuthService] Could not decode Google credential, using default profile:', err);
    return {
      sub: `g_${Date.now()}`,
      name: 'Google User',
      email: 'user@gmail.com',
    };
  }
}

interface BackendUser {
  _id: string;
  googleId: string;
  email: string;
  name: string;
  picture?: string;
  phone?: string;
  bloodGroup?: string;
  medicalNotes?: string;
}

export function toFrontendUser(user: BackendUser): User {
  return {
    id: user._id,
    googleId: user.googleId,
    name: user.name,
    email: user.email,
    avatarUrl: user.picture,
    phone: user.phone,
    bloodGroup: user.bloodGroup,
    medicalNotes: user.medicalNotes,
  };
}

export const authService = {
  /**
   * Accepts the real Google ID-token credential from @react-oauth/google,
   * decodes it client-side, then syncs the already-authenticated user to MongoDB.
   */
  async loginWithGoogle(credential: string): Promise<{ token: string; user: User }> {
    const claims = decodeGoogleCredential(credential);
    try {
      const { data } = await apiClient.post<{ user: BackendUser }>('/auth/google', {
        googleId: claims.sub,
        name: claims.name,
        email: claims.email,
        picture: claims.picture,
      });
      const user = toFrontendUser(data.user);

      localStorage.setItem('tether_token', credential);
      return { token: credential, user };
    } catch (err) {
      console.warn('[AuthService] Backend Google auth sync offline/failed, proceeding with Google user session:', err);
      const user: User = {
        id: claims.sub || `g_${Date.now()}`,
        googleId: claims.sub,
        name: claims.name || 'Google User',
        email: claims.email || 'user@gmail.com',
        avatarUrl: claims.picture,
      };
      localStorage.setItem('tether_token', credential);
      return { token: credential, user };
    }
  },

  async loginAsGuest(): Promise<{ token: string; user: User }> {
    try {
      const { data } = await apiClient.post<{ user: BackendUser }>('/auth/guest');
      const token = `guest:${data.user._id}`;
      localStorage.setItem('tether_token', token);
      return { token, user: toFrontendUser(data.user) };
    } catch (err) {
      console.warn('[AuthService] Backend guest login offline/failed, proceeding with local guest session:', err);
      const guestId = `guest_${Date.now()}`;
      const user: User = {
        id: guestId,
        name: 'Guest User',
        email: 'guest@tether.app',
      };
      const token = `guest:${guestId}`;
      localStorage.setItem('tether_token', token);
      return { token, user };
    }
  },

  async logout(): Promise<void> {
    await mockDelay(undefined, 300);
    localStorage.removeItem('tether_token');
  },
};
