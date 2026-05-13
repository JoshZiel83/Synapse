import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

function getWebStorage() {
  if (typeof window === "undefined") return null
  return window.localStorage
}

export async function readStoredValue(key: string) {
  if (Platform.OS === "web") {
    return getWebStorage()?.getItem(key) ?? null
  }

  return SecureStore.getItemAsync(key)
}

export async function writeStoredValue(key: string, value: string) {
  if (Platform.OS === "web") {
    getWebStorage()?.setItem(key, value)
    return
  }

  await SecureStore.setItemAsync(key, value)
}

export async function deleteStoredValue(key: string) {
  if (Platform.OS === "web") {
    getWebStorage()?.removeItem(key)
    return
  }

  await SecureStore.deleteItemAsync(key)
}
