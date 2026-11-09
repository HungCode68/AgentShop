const STORAGE_KEY = 'quota-monitor:key'

/** The API key the user chose to remember on the quota page (shared with the Chatbox guide). */
export const savedKey = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(STORAGE_KEY, v)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* storage unavailable */
    }
  },
}
