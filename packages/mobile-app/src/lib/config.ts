import Constants from 'expo-constants';
import { Platform } from 'react-native';

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function resolveApiBase() {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!configured) {
    throw new Error(
      'Missing EXPO_PUBLIC_API_URL. Set it at build time, for example: https://your-api-host/api/v1',
    );
  }

  const normalizedInput = /^https?:\/\//i.test(configured)
    ? configured
    : `https://${configured}`;
  const url = new URL(normalizedInput);

  if (url.pathname === '/' || url.pathname.trim().length === 0) {
    url.pathname = '/api/v1';
  }

  return trimTrailingSlash(url.toString());
}

export const API_BASE = resolveApiBase();
export const API_ORIGIN = new URL(API_BASE).origin;

export function resolveApiUrl(pathOrUrl: string) {
  if (!pathOrUrl) return pathOrUrl;

  try {
    return new URL(pathOrUrl).toString();
  } catch {
    const normalized = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return new URL(normalized, API_ORIGIN).toString();
  }
}

export function getPlatformClientType() {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

export function getDeviceLabel() {
  const deviceName = Constants.deviceName?.trim();
  if (deviceName) return deviceName;
  return Platform.OS === 'ios' ? 'iPhone App' : 'Android App';
}
